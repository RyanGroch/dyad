import type { Message, StreamingPatch } from "@/ipc/types";
import { hashPrefix } from "@/lib/prefixHash";

/**
 * Applies a tail-only streaming patch to the messages-by-id map atom.
 * Reconstructs the streaming message content as `current.slice(0, offset) + content`.
 *
 * Returns false when the local content is an invalid base for the patch:
 *   - content is shorter than offset (stale DB overwrite dropped bytes), or
 *   - djb2 hash of the local prefix disagrees with prefixHash (stale DB content
 *     has same length but different prefix, e.g. a cleanFullResponse < → ＜
 *     rewrite that occurred anywhere in the prefix after the DB write).
 * The caller should resync on false instead of splicing a new tail onto the wrong base.
 */
export function applyStreamingPatch(
  setMessagesById: (
    update: (prev: Map<number, Message[]>) => Map<number, Message[]>,
  ) => void,
  chatId: number,
  streamingMessageId: number,
  streamingPatch: StreamingPatch,
): boolean {
  const { offset, content, prefixHash } = streamingPatch;
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
        prefixHash !== undefined &&
        offset > 0 &&
        hashPrefix(currentContent, offset) !== prefixHash
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
