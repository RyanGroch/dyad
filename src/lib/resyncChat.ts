import { ipc } from "@/ipc/types";
import type { Message } from "@/ipc/types";
import { hashPrefix } from "@/lib/prefixHash";

const pendingResyncChatIds = new Set<number>();

const RESYNC_TIMEOUT_MS = 10_000;

/**
 * Merges a DB messages snapshot into the live renderer messages for a chat.
 * For the streaming message, keeps the live version only when it is a valid
 * extension of the DB snapshot: live content must be longer AND its prefix up
 * to the DB snapshot length must hash-match (proving patches advanced the
 * renderer correctly past the snapshot without corrupting the base).
 * Falls back to the DB version otherwise, including when live content is longer
 * but has a wrong prefix (corrupted base that caused the patch failure).
 */
export function mergeResyncMessages(
  dbMessages: Message[],
  prevMessages: Message[],
): Message[] {
  return dbMessages.map((dbMsg) => {
    const live = prevMessages.find((m) => m.id === dbMsg.id);
    if (!live) return dbMsg;
    const dbLen = dbMsg.content?.length ?? 0;
    const liveLen = live.content?.length ?? 0;
    if (
      liveLen > dbLen &&
      hashPrefix(live.content ?? "", dbLen) ===
        hashPrefix(dbMsg.content ?? "", dbLen)
    ) {
      return live;
    }
    return dbMsg;
  });
}

/**
 * Triggers a best-effort resync of chat messages from the DB when a streaming
 * patch detects a stale or corrupted renderer base (applyStreamingPatch returns false).
 *
 * Deduplicates concurrent resync fetches per chatId. If the fetch hangs past
 * RESYNC_TIMEOUT_MS the gate entry is cleared so future mismatches can retry.
 * onEnd always performs a final authoritative sync, so this is recovery-only.
 */
export function triggerResync(
  chatId: number,
  setMessagesById: (
    update: (prev: Map<number, Message[]>) => Map<number, Message[]>,
  ) => void,
): void {
  if (pendingResyncChatIds.has(chatId)) return;
  pendingResyncChatIds.add(chatId);

  let timeoutId: ReturnType<typeof setTimeout>;
  const fetchWithTimeout = Promise.race([
    ipc.chat.getChat(chatId),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(new Error(`resync timed out after ${RESYNC_TIMEOUT_MS}ms`)),
        RESYNC_TIMEOUT_MS,
      );
    }),
  ]);

  fetchWithTimeout
    .then((chat) => {
      setMessagesById((prev) => {
        const prevMessages = prev.get(chatId);
        const next = new Map(prev);
        next.set(
          chatId,
          prevMessages
            ? mergeResyncMessages(chat.messages, prevMessages)
            : chat.messages,
        );
        return next;
      });
    })
    .catch((err) => {
      console.warn(
        "[CHAT] Streaming resync fetch failed for chat",
        chatId,
        err,
      );
    })
    .finally(() => {
      clearTimeout(timeoutId);
      pendingResyncChatIds.delete(chatId);
    });
}
