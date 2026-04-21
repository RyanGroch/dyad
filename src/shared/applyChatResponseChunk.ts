import type { Message } from "@/ipc/types";

export interface ChatResponseChunkFields {
  messages?: Message[];
  streamingMessageId?: number;
  streamingContent?: string;
  streamingPatch?: { offset: number; content: string };
}

/**
 * Applies a `chat:response:chunk` event to an existing messages array for a
 * given chat, returning the new array (or the same reference if nothing
 * changed). Callers are responsible for storing the result.
 *
 * The three event shapes (full messages, streaming snapshot, streaming patch)
 * are documented on `ChatResponseChunkSchema` in `src/ipc/types/chat.ts`.
 */
export function applyChatResponseChunk(
  existingMessages: Message[] | undefined,
  chunk: ChatResponseChunkFields,
): Message[] | undefined {
  if (chunk.messages) {
    return chunk.messages;
  }

  if (!existingMessages) {
    return existingMessages;
  }

  const { streamingMessageId, streamingContent, streamingPatch } = chunk;
  if (streamingMessageId === undefined) {
    return existingMessages;
  }

  if (streamingContent !== undefined) {
    return existingMessages.map((msg) =>
      msg.id === streamingMessageId
        ? { ...msg, content: streamingContent }
        : msg,
    );
  }

  if (streamingPatch) {
    const { offset, content } = streamingPatch;
    return existingMessages.map((msg) => {
      if (msg.id !== streamingMessageId) return msg;
      const current = msg.content ?? "";
      return { ...msg, content: current.slice(0, offset) + content };
    });
  }

  return existingMessages;
}
