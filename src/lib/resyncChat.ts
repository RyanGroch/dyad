import { ipc } from "@/ipc/types";
import type { Message } from "@/ipc/types";
import { mergeResyncMessages } from "@/lib/prefixHash";

const pendingResyncChatIds = new Set<number>();

const RESYNC_TIMEOUT_MS = 10_000;

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

  const fetchWithTimeout = Promise.race([
    ipc.chat.getChat(chatId),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`resync timed out after ${RESYNC_TIMEOUT_MS}ms`)),
        RESYNC_TIMEOUT_MS,
      ),
    ),
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
      pendingResyncChatIds.delete(chatId);
    });
}
