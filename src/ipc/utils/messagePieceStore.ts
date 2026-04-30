import { db } from "../../db";
import { messages, messagePieces } from "../../db/schema";
import { eq, asc } from "drizzle-orm";
import { segmentMessageContent } from "./messagePieceSegmenter";
import { stripCancelledResponseNotice } from "@/shared/chatCancellation";
import log from "electron-log";

const logger = log.scope("messagePieceStore");

const inflight = new Map<number, Promise<void>>();

/**
 * Ensures `message_pieces` rows exist for `messageId`. For old assistant
 * messages that pre-date the table, segments their stored content on first
 * read. No-ops for user messages (no need to window them) and for messages
 * that already have pieces.
 *
 * Concurrent callers for the same id share the same in-flight promise.
 */
export async function ensurePiecesForMessage(messageId: number): Promise<void> {
  const existing = inflight.get(messageId);
  if (existing) return existing;
  const p = (async () => {
    const msg = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
      columns: { id: true, role: true, content: true },
    });
    if (!msg) return;
    if (msg.role !== "assistant") return;
    const any = await db.query.messagePieces.findFirst({
      where: eq(messagePieces.messageId, messageId),
      columns: { id: true },
    });
    if (any) return;
    const content = stripCancelledResponseNotice(msg.content);
    if (!content) return;
    const pieces = segmentMessageContent(content);
    if (pieces.length === 0) return;
    await db.insert(messagePieces).values(
      pieces.map((p) => ({
        messageId,
        pieceIndex: p.pieceIndex,
        type: p.type,
        content: p.content,
        attributesJson: p.attributesJson,
        byteStart: p.byteStart,
        byteEnd: p.byteEnd,
        estHeightPx: p.estHeightPx,
      })),
    );
  })();
  inflight.set(messageId, p);
  try {
    await p;
  } catch (err) {
    logger.error(`segmentation failed for ${messageId}`, err);
    throw err;
  } finally {
    inflight.delete(messageId);
  }
}

/**
 * Replaces all pieces for `messageId` with the result of segmenting `content`.
 * Used at stream completion to durably store the final segmented form.
 */
export async function rewritePiecesForMessage(
  messageId: number,
  content: string,
): Promise<void> {
  const cleanContent = stripCancelledResponseNotice(content);
  await db
    .delete(messagePieces)
    .where(eq(messagePieces.messageId, messageId));
  if (!cleanContent) return;
  const pieces = segmentMessageContent(cleanContent);
  if (pieces.length === 0) return;
  await db.insert(messagePieces).values(
    pieces.map((p) => ({
      messageId,
      pieceIndex: p.pieceIndex,
      type: p.type,
      content: p.content,
      attributesJson: p.attributesJson,
      byteStart: p.byteStart,
      byteEnd: p.byteEnd,
      estHeightPx: p.estHeightPx,
    })),
  );
}

/** Read-back helper for tests / direct callers. */
export async function getPiecesForMessage(messageId: number) {
  return db
    .select()
    .from(messagePieces)
    .where(eq(messagePieces.messageId, messageId))
    .orderBy(asc(messagePieces.pieceIndex));
}
