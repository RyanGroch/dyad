import { useMemo, useRef } from "react";
import {
  parseCustomTags,
  type ContentPiece,
} from "@/shared/dyadTagParser";
import { stripCancelledResponseNotice } from "@/shared/chatCancellation";

interface CacheSlot {
  content: string;
  pieces: ContentPiece[];
  safeBoundary: number;
}

/**
 * Client-side incremental parse of an in-flight assistant message. Only the
 * tail beyond `safeBoundary` is re-parsed each chunk; finalized pieces keep
 * stable refs so `MemoMarkdown` / `MemoCustomTag` short-circuit downstream.
 *
 * Used to drive per-piece virtualization for the streaming message — pieces
 * aren't durable in `message_pieces` until stream end, so we can't fetch
 * them via IPC during streaming.
 */
export function useStreamingPieces(content: string): ContentPiece[] {
  const cacheRef = useRef<CacheSlot | null>(null);
  return useMemo(() => {
    const cleaned = stripCancelledResponseNotice(content);
    const prev = cacheRef.current;
    let pieces: ContentPiece[];
    let safeBoundary: number;

    if (
      prev &&
      prev.safeBoundary > 0 &&
      cleaned.length >= prev.safeBoundary &&
      cleaned.startsWith(prev.content.slice(0, prev.safeBoundary))
    ) {
      const reused: ContentPiece[] = [];
      for (const p of prev.pieces) {
        if (p._end <= prev.safeBoundary) reused.push(p);
        else break;
      }
      const reusedEnd = reused.length ? reused[reused.length - 1]._end : 0;
      const tail = cleaned.slice(reusedEnd);
      const tailResult = parseCustomTags(tail, reusedEnd);
      const merged: ContentPiece[] = reused.slice();
      const tailPieces = tailResult.pieces;
      let tailStart = 0;
      if (
        merged.length > 0 &&
        tailPieces.length > 0 &&
        merged[merged.length - 1].type === "markdown" &&
        tailPieces[0].type === "markdown"
      ) {
        const last = merged[merged.length - 1] as Extract<
          ContentPiece,
          { type: "markdown" }
        >;
        const first = tailPieces[0] as Extract<
          ContentPiece,
          { type: "markdown" }
        >;
        merged[merged.length - 1] = {
          type: "markdown",
          content: last.content + first.content,
          _start: last._start,
          _end: first._end,
        };
        tailStart = 1;
      }
      for (let i = tailStart; i < tailPieces.length; i++) {
        merged.push(tailPieces[i]);
      }
      pieces = merged;
      safeBoundary = tailResult.safeBoundary;
    } else {
      const r = parseCustomTags(cleaned, 0);
      pieces = r.pieces;
      safeBoundary = r.safeBoundary;
    }

    cacheRef.current = { content: cleaned, pieces, safeBoundary };
    return pieces;
  }, [content]);
}
