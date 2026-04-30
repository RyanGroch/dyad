import { useEffect, useState } from "react";
import { ipc } from "@/ipc/types";
import type { MessagePiece } from "@/ipc/types/chat";

interface CacheEntry {
  piece: MessagePiece | null;
  inflight: Promise<MessagePiece> | null;
  error: string | null;
}

const cache = new Map<string, CacheEntry>();
const subscribers = new Map<string, Set<() => void>>();

const keyOf = (messageId: number, pieceIndex: number) =>
  `${messageId}:${pieceIndex}`;

function notify(key: string) {
  const subs = subscribers.get(key);
  if (!subs) return;
  for (const fn of subs) fn();
}

function fetchPiece(messageId: number, pieceIndex: number) {
  const key = keyOf(messageId, pieceIndex);
  const existing = cache.get(key);
  if (existing?.piece) return existing.piece;
  if (existing?.inflight) return existing.inflight;

  const promise = ipc.chat
    .getMessagePieceDetail({ messageId, pieceIndex })
    .then((piece) => {
      cache.set(key, { piece, inflight: null, error: null });
      notify(key);
      return piece;
    })
    .catch((err) => {
      cache.set(key, {
        piece: null,
        inflight: null,
        error: String(err?.message ?? err),
      });
      notify(key);
      throw err;
    });

  cache.set(key, { piece: null, inflight: promise, error: null });
  return promise;
}

/**
 * Resolves the full content of one piece. While loading, returns null. On
 * subsequent mounts of the same piece, returns from cache synchronously.
 *
 * The cache is process-wide (module-scoped) so unmount/remount during scroll
 * doesn't hammer the DB. Drop entries by chat switch (call `clearPieceCache`)
 * if memory pressure becomes an issue — for now LRU is unbounded.
 */
export function useMessagePieceContent(
  messageId: number,
  pieceIndex: number,
): { piece: MessagePiece | null; error: string | null; isLoading: boolean } {
  const key = keyOf(messageId, pieceIndex);
  const initial = cache.get(key);
  const [, force] = useState(0);
  const [piece, setPiece] = useState<MessagePiece | null>(
    initial?.piece ?? null,
  );
  const [error, setError] = useState<string | null>(initial?.error ?? null);

  useEffect(() => {
    let cancelled = false;
    const subFn = () => {
      const e = cache.get(key);
      if (!e) return;
      setPiece(e.piece);
      setError(e.error);
      force((x) => x + 1);
    };
    let subs = subscribers.get(key);
    if (!subs) {
      subs = new Set();
      subscribers.set(key, subs);
    }
    subs.add(subFn);

    const cached = cache.get(key);
    if (cached?.piece) {
      setPiece(cached.piece);
      setError(null);
    } else {
      Promise.resolve(fetchPiece(messageId, pieceIndex))
        .then((p) => {
          if (cancelled) return;
          setPiece(p);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(String(err?.message ?? err));
        });
    }

    return () => {
      cancelled = true;
      subs?.delete(subFn);
      if (subs && subs.size === 0) subscribers.delete(key);
    };
  }, [key, messageId, pieceIndex]);

  return { piece, error, isLoading: !piece && !error };
}

export function clearPieceCache() {
  cache.clear();
}
