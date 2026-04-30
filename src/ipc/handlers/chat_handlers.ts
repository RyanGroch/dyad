import { db } from "../../db";
import { apps, chats, messages, messagePieces } from "../../db/schema";
import { desc, eq, and, like, asc, gte, lt } from "drizzle-orm";
import type { ChatSearchResult, ChatSummary } from "../../lib/schemas";

import log from "electron-log";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { getDyadAppPath } from "../../paths/paths";
import { getCurrentCommitHash } from "../utils/git_utils";
import { createTypedHandler } from "./base";
import { chatContracts } from "../types/chat";
import { ensurePiecesForMessage } from "../utils/messagePieceStore";
import { isCancelledResponseContent } from "@/shared/chatCancellation";

const logger = log.scope("chat_handlers");

export function registerChatHandlers() {
  createTypedHandler(chatContracts.createChat, async (_, appId) => {
    // Get the app's path first
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
      columns: {
        path: true,
      },
    });

    if (!app) {
      throw new DyadError("App not found", DyadErrorKind.NotFound);
    }

    let initialCommitHash = null;
    try {
      // Get the current git revision of the currently checked-out branch
      initialCommitHash = await getCurrentCommitHash({
        path: getDyadAppPath(app.path),
      });
    } catch (error) {
      logger.error("Error getting git revision:", error);
      // Continue without the git revision
    }

    // Create a new chat
    const [chat] = await db
      .insert(chats)
      .values({
        appId,
        initialCommitHash,
      })
      .returning();
    logger.info(
      "Created chat:",
      chat.id,
      "for app:",
      appId,
      "with initial commit hash:",
      initialCommitHash,
    );
    return chat.id;
  });

  createTypedHandler(chatContracts.getChat, async (_, chatId) => {
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
      with: {
        messages: {
          orderBy: (messages, { asc }) => [asc(messages.createdAt)],
        },
      },
    });

    if (!chat) {
      throw new DyadError("Chat not found", DyadErrorKind.NotFound);
    }

    // Backfill pieces for all assistant messages so the renderer can fetch
    // per-piece via IPC immediately on chat open. Done in parallel; failures
    // are logged but non-fatal (renderer will retry per-message).
    await Promise.all(
      chat.messages
        .filter((m) => m.role === "assistant")
        .map((m) =>
          ensurePiecesForMessage(m.id).catch((err) =>
            logger.error(`backfill failed for message ${m.id}:`, err),
          ),
        ),
    );

    return {
      ...chat,
      title: chat.title ?? "",
      messages: chat.messages.map((m) => {
        const role = m.role as "user" | "assistant";
        if (role === "assistant") {
          // Strip content from the wire payload — pieces are durable in DB
          // and the renderer fetches them lazily. Preserve cancel-state via
          // the derived flag so the UI can still render the cancelled badge.
          return {
            ...m,
            role,
            content: "",
            isCancelled: isCancelledResponseContent(m.content),
          };
        }
        return { ...m, role };
      }),
    };
  });

  createTypedHandler(chatContracts.getChats, async (_, appId) => {
    // If appId is provided, filter chats for that app
    const query = appId
      ? db.query.chats.findMany({
          where: eq(chats.appId, appId),
          columns: {
            id: true,
            title: true,
            createdAt: true,
            appId: true,
          },
          orderBy: [desc(chats.createdAt)],
        })
      : db.query.chats.findMany({
          columns: {
            id: true,
            title: true,
            createdAt: true,
            appId: true,
          },
          orderBy: [desc(chats.createdAt)],
        });

    const allChats = await query;
    return allChats as ChatSummary[];
  });

  createTypedHandler(chatContracts.deleteChat, async (_, chatId) => {
    await db.delete(chats).where(eq(chats.id, chatId));
  });

  createTypedHandler(chatContracts.updateChat, async (_, params) => {
    const { chatId, title } = params;
    await db.update(chats).set({ title }).where(eq(chats.id, chatId));
  });

  createTypedHandler(chatContracts.deleteMessages, async (_, chatId) => {
    await db.delete(messages).where(eq(messages.chatId, chatId));
  });

  createTypedHandler(chatContracts.searchChats, async (_, params) => {
    const { appId, query } = params;
    // 1) Find chats by title and map to ChatSearchResult with no matched message
    const chatTitleMatches = await db
      .select({
        id: chats.id,
        appId: chats.appId,
        title: chats.title,
        createdAt: chats.createdAt,
      })
      .from(chats)
      .where(and(eq(chats.appId, appId), like(chats.title, `%${query}%`)))
      .orderBy(desc(chats.createdAt))
      .limit(10);

    const titleResults: ChatSearchResult[] = chatTitleMatches.map((c) => ({
      id: c.id,
      appId: c.appId,
      title: c.title,
      createdAt: c.createdAt,
      matchedMessageContent: null,
    }));

    // 2) Find messages that match and join to chats to build one result per message
    const messageResults = await db
      .select({
        id: chats.id,
        appId: chats.appId,
        title: chats.title,
        createdAt: chats.createdAt,
        matchedMessageContent: messages.content,
      })
      .from(messages)
      .innerJoin(chats, eq(messages.chatId, chats.id))
      .where(and(eq(chats.appId, appId), like(messages.content, `%${query}%`)))
      .orderBy(desc(chats.createdAt))
      .limit(10);

    // Combine: keep title matches and per-message matches
    const combined: ChatSearchResult[] = [...titleResults, ...messageResults];
    const uniqueChats = Array.from(
      new Map(combined.map((item) => [item.id, item])).values(),
    );

    // Sort newest chats first
    uniqueChats.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return uniqueChats;
  });

  createTypedHandler(
    chatContracts.getMessagePiecesMetadata,
    async (_, { messageId }) => {
      await ensurePiecesForMessage(messageId);
      const rows = await db
        .select({
          pieceIndex: messagePieces.pieceIndex,
          type: messagePieces.type,
          attributesJson: messagePieces.attributesJson,
          byteStart: messagePieces.byteStart,
          byteEnd: messagePieces.byteEnd,
          estHeightPx: messagePieces.estHeightPx,
        })
        .from(messagePieces)
        .where(eq(messagePieces.messageId, messageId))
        .orderBy(asc(messagePieces.pieceIndex));
      return rows.map((r) => ({
        pieceIndex: r.pieceIndex,
        type: r.type,
        attributes: r.attributesJson,
        byteStart: r.byteStart,
        byteEnd: r.byteEnd,
        estHeightPx: r.estHeightPx,
      }));
    },
  );

  createTypedHandler(
    chatContracts.getMessagePieceRange,
    async (_, { messageId, fromIndex, toIndex }) => {
      await ensurePiecesForMessage(messageId);
      const rows = await db
        .select()
        .from(messagePieces)
        .where(
          and(
            eq(messagePieces.messageId, messageId),
            gte(messagePieces.pieceIndex, fromIndex),
            lt(messagePieces.pieceIndex, toIndex),
          ),
        )
        .orderBy(asc(messagePieces.pieceIndex));
      return rows.map((r) => ({
        pieceIndex: r.pieceIndex,
        type: r.type,
        content: r.content,
        attributes: r.attributesJson,
        byteStart: r.byteStart,
        byteEnd: r.byteEnd,
        estHeightPx: r.estHeightPx,
      }));
    },
  );

  createTypedHandler(
    chatContracts.getMessagePieceDetail,
    async (_, { messageId, pieceIndex }) => {
      await ensurePiecesForMessage(messageId);
      const row = await db.query.messagePieces.findFirst({
        where: and(
          eq(messagePieces.messageId, messageId),
          eq(messagePieces.pieceIndex, pieceIndex),
        ),
      });
      if (!row) {
        throw new DyadError("Piece not found", DyadErrorKind.NotFound);
      }
      return {
        pieceIndex: row.pieceIndex,
        type: row.type,
        content: row.content,
        attributes: row.attributesJson,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
        estHeightPx: row.estHeightPx,
      };
    },
  );

  createTypedHandler(chatContracts.getMessageFullText, async (_, messageId) => {
    const msg = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { content: true },
    });
    if (!msg) {
      throw new DyadError("Message not found", DyadErrorKind.NotFound);
    }
    return msg.content;
  });

  logger.debug("Registered chat IPC handlers");
}
