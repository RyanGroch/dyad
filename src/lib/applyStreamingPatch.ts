import type { Message, StreamingPatch } from "@/ipc/types";

/**
 * Applies a tail-only streaming patch to the messages-by-id map atom.
 * Reconstructs the streaming message content as `current.slice(0, offset) + content`.
 *
 * Returns false when the local content is shorter than offset, which means a
 * stale full-refresh overwrote the renderer state. The caller should resync.
 */
export function applyStreamingPatch(
  setMessagesById: (
    update: (prev: Map<number, Message[]>) => Map<number, Message[]>,
  ) => void,
  chatId: number,
  streamingMessageId: number,
  streamingPatch: StreamingPatch,
): boolean {
  const { offset, content } = streamingPatch;
  let offsetMismatch = false;
  setMessagesById((prev) => {
    const existingMessages = prev.get(chatId);
    if (!existingMessages) return prev;
    const next = new Map(prev);
    const updated = existingMessages.map((msg) => {
      if (msg.id !== streamingMessageId) return msg;
      const currentContent = msg.content ?? "";
      if (currentContent.length < offset) {
        offsetMismatch = true;
        return msg;
      }
      return { ...msg, content: currentContent.slice(0, offset) + content };
    });
    next.set(chatId, updated);
    return next;
  });
  return !offsetMismatch;
}
