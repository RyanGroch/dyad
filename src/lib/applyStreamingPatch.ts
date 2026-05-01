import type { Message, StreamingPatch } from "@/ipc/types";

/**
 * Applies a tail-only streaming patch to the messages-by-id map atom.
 * Reconstructs the streaming message content as `current.slice(0, offset) + content`.
 */
export function applyStreamingPatch(
  setMessagesById: (
    update: (prev: Map<number, Message[]>) => Map<number, Message[]>,
  ) => void,
  chatId: number,
  streamingMessageId: number,
  streamingPatch: StreamingPatch,
): void {
  const { offset, content } = streamingPatch;
  setMessagesById((prev) => {
    const existingMessages = prev.get(chatId);
    if (!existingMessages) return prev;
    const next = new Map(prev);
    const updated = existingMessages.map((msg) => {
      if (msg.id !== streamingMessageId) return msg;
      const currentContent = msg.content ?? "";
      return { ...msg, content: currentContent.slice(0, offset) + content };
    });
    next.set(chatId, updated);
    return next;
  });
}
