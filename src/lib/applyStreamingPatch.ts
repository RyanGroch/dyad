import type { Message, StreamingPatch } from "@/ipc/types";

/**
 * Applies a tail-only streaming patch to the messages-by-id map atom.
 * Reconstructs the streaming message content as `current.slice(0, offset) + content`.
 *
 * Returns false when the local content is an invalid base for the patch:
 *   - content is shorter than offset (stale DB overwrite dropped bytes), or
 *   - the char at offset-1 disagrees with checkChar (same-length wrong prefix,
 *     e.g. a cleanFullResponse rewrite that landed in the DB before the rewrite).
 * The caller should resync on false instead of applying subsequent patches to a
 * corrupt base.
 */
export function applyStreamingPatch(
  setMessagesById: (
    update: (prev: Map<number, Message[]>) => Map<number, Message[]>,
  ) => void,
  chatId: number,
  streamingMessageId: number,
  streamingPatch: StreamingPatch,
): boolean {
  const { offset, content, checkChar } = streamingPatch;
  let baseMismatch = false;
  setMessagesById((prev) => {
    const existingMessages = prev.get(chatId);
    if (!existingMessages) return prev;
    const next = new Map(prev);
    const updated = existingMessages.map((msg) => {
      if (msg.id !== streamingMessageId) return msg;
      const currentContent = msg.content ?? "";
      if (currentContent.length < offset) {
        baseMismatch = true;
        return msg;
      }
      if (
        checkChar !== undefined &&
        offset > 0 &&
        currentContent[offset - 1] !== checkChar
      ) {
        baseMismatch = true;
        return msg;
      }
      return { ...msg, content: currentContent.slice(0, offset) + content };
    });
    next.set(chatId, updated);
    return next;
  });
  return !baseMismatch;
}
