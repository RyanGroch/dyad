import log from "electron-log";

const logger = log.scope("stream_text_utils");

// Minimal structural type for the undocumented `baseStream` field the AI
// SDK leaves on its `streamText` result after `.fullStream` is read. The
// SDK does not expose this in its public types, so we narrow just enough
// to call `.cancel()` without falling back to `any`.
interface StreamTextResultWithBaseStream {
  baseStream?: {
    cancel?: () => Promise<void> | void;
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
  const orphan = streamResult as StreamTextResultWithBaseStream;
  const baseStream = orphan?.baseStream;
  const cancel = baseStream?.cancel;
  if (typeof cancel !== "function") return;
  Promise.resolve(cancel.call(baseStream)).catch((err: unknown) => {
    logger.warn("Failed to cancel orphaned streamText baseStream branch", err);
  });
}
