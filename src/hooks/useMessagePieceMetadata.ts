import { useEffect, useRef, useState } from "react";
import type { Message } from "@/ipc/types";
import { ipc } from "@/ipc/types";
import type { MessagePieceMetadata } from "@/ipc/types/chat";

export interface MessagePiecesMetadata {
  messageId: number;
  pieces: MessagePieceMetadata[];
  isLoading: boolean;
  error?: string;
}

/**
 * For each non-streaming assistant message, fetch its piece metadata via IPC.
 * The streaming message (last assistant when isStreaming) is excluded —
 * pieces aren't durable yet during streaming.
 *
 * Uses an in-memory cache keyed by messageId so messages already fetched
 * aren't re-fetched on re-render. Pass `bumpKey` (e.g. timestamp from
 * stream-end events) to force re-fetch for a specific message.
 */
export function useMessagePieceMetadata(
  messages: Message[],
  isStreaming: boolean,
  refetchKey: number = 0,
): Map<number, MessagePiecesMetadata> {
  const [state, setState] = useState<Map<number, MessagePiecesMetadata>>(
    new Map(),
  );
  const cacheRef = useRef<Map<number, MessagePiecesMetadata>>(new Map());
  const inflightRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const wantedIds: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      const isLastAssistant = i === messages.length - 1;
      if (isStreaming && isLastAssistant) continue;
      wantedIds.push(m.id);
    }

    let dirty = false;
    const next = new Map(cacheRef.current);

    for (const id of wantedIds) {
      if (next.has(id)) continue;
      if (inflightRef.current.has(id)) continue;
      inflightRef.current.add(id);
      next.set(id, { messageId: id, pieces: [], isLoading: true });
      dirty = true;
      ipc.chat
        .getMessagePiecesMetadata({ messageId: id })
        .then((pieces) => {
          if (cancelled) return;
          cacheRef.current.set(id, {
            messageId: id,
            pieces,
            isLoading: false,
          });
          setState(new Map(cacheRef.current));
        })
        .catch((err) => {
          if (cancelled) return;
          cacheRef.current.set(id, {
            messageId: id,
            pieces: [],
            isLoading: false,
            error: String(err?.message ?? err),
          });
          setState(new Map(cacheRef.current));
        })
        .finally(() => {
          inflightRef.current.delete(id);
        });
    }

    if (dirty) {
      cacheRef.current = next;
      setState(next);
    }

    return () => {
      cancelled = true;
    };
  }, [messages, isStreaming, refetchKey]);

  return state;
}

/** Drop cached metadata for a message id — forces refetch on next render. */
export function invalidateMessagePieceMetadata(
  cache: Map<number, MessagePiecesMetadata>,
  messageId: number,
): Map<number, MessagePiecesMetadata> {
  const next = new Map(cache);
  next.delete(messageId);
  return next;
}
