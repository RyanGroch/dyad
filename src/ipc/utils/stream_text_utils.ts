import log from "electron-log";

const logger = log.scope("stream_text_utils");

/**
 * Computes a tail-only streaming patch from `lastSentContent` to `fullResponse`
 * using longest-common-prefix. Returns null when nothing changed.
 *
 * The renderer reconstructs the full string as `current.slice(0, offset) + content`.
 * We use LCP rather than assuming pure appends because `cleanFullResponse` may
 * retroactively rewrite bytes inside in-progress dyad-tag attribute values.
 */
export function computeStreamingPatch(
  fullResponse: string,
  lastSentContent: string,
): { offset: number; content: string; checkChar?: string } | null {
  let lcp = 0;
  const maxLcp = Math.min(lastSentContent.length, fullResponse.length);
  while (
    lcp < maxLcp &&
    lastSentContent.charCodeAt(lcp) === fullResponse.charCodeAt(lcp)
  ) {
    lcp++;
  }
  const tail = fullResponse.slice(lcp);
  if (tail.length === 0 && lcp === lastSentContent.length) {
    return null;
  }
  return {
    offset: lcp,
    content: tail,
    // Include the last char of the agreed prefix so the renderer can detect
    // stale-base mismatches that have the same length but wrong content
    // (e.g. a cleanFullResponse < → ＜ rewrite that occurred after the DB write).
    checkChar: lcp > 0 ? fullResponse[lcp - 1] : undefined,
  };
}

/**
 * Cancel the orphaned `baseStream` tee branch the AI SDK leaves behind
 * after `.fullStream` is read.
 *
 * Reading `.fullStream` runs the SDK's `teeStream()` synchronously: it
 * splits the SDK's internal `baseStream` into two branches and
 * reassigns the unread branch back onto `streamResult.baseStream`.
 * WhatWG `tee()` enqueues every upstream chunk into both branches'
 * controllers regardless of whether they have a reader, so the unread
 * branch's queue grows unbounded as the model streams — the dominant
 * in-flight memory leak observed in heap snapshots (`{part,
 * partialOutput}` objects parked in a `ReadableStreamDefaultController`
 * queue, rooted via the undici connection pool).
 *
 * Call this immediately after reading `.fullStream` and before the
 * stream begins pumping chunks. The cancel runs before any chunks are
 * pumped, so the orphan controller closes immediately and future
 * enqueues to it are no-ops.
 */
export function cancelOrphanedBaseStream(streamResult: unknown): void {
  const orphan: any = streamResult;
  orphan?.baseStream?.cancel?.()?.catch?.((err: unknown) => {
    logger.warn("Failed to cancel orphaned streamText baseStream branch", err);
  });
}
