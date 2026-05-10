import log from "electron-log";
import type { StreamingPatch } from "@/ipc/types";
import {
  createAckBackpressure,
  type AckBackpressure,
} from "./ack_backpressure";
import { createPatchCoalescer } from "./streaming_patch_coalesce";

const logger = log.scope("streaming_patch_throttle");

// IPC patch send window. Newer patches arriving inside this window are
// coalesced and emitted on the trailing edge instead of firing per-chunk.
// 16ms ≈ 60Hz: caps renderer paint work to one apply-per-frame while
// keeping streaming text visually smooth.
export const IPC_STREAM_THROTTLE_MS = 16;

// Hold sends when in-flight (sent − acked) reaches this many patches —
// the renderer is falling behind and adding more sends just deepens the
// queue. New patches keep coalescing into the pending merged patch; drain
// resumes when an ack pulls backlog under threshold (one big catch-up
// patch instead of many small ones). End-of-stream full-messages
// replacement always delivers final content, so a stalled ack channel
// can't strand the renderer on stale state — no watchdog needed.
export const IPC_STREAM_BACKPRESSURE_THRESHOLD = 20;

export type SendPatchFn = (patch: StreamingPatch, chunkSeq: number) => void;

export interface StreamingPatchThrottle {
  /** Queue a patch for throttled, backpressured send to the renderer. */
  queue(patch: StreamingPatch): void;

  /** Drop any pending patch without sending. Use before a full-messages-replacement. */
  cancel(): void;

  /** Tear down and emit a one-shot end-of-stream summary. Idempotent. */
  destroy(emitSummary?: boolean): void;
}

/**
 * Throttled, backpressured sender for `chat:response:chunk` tail patches.
 *
 * Composes three concerns:
 * - **coalesce** ({@link createPatchCoalescer}): merge fast-arriving patches
 *   into a single pending tail patch.
 * - **backpressure** ({@link createAckBackpressure}): hold sends when the
 *   renderer falls behind, resume on ack drain.
 * - **throttle window**: leading-edge fire if the window has elapsed,
 *   otherwise trailing-edge fire at window's end.
 *
 * `cancel()` MUST be called before any full messages-array replacement on
 * the same channel — a stale tail patch firing after a messages-replacement
 * gets reapplied against the wrong base and truncates the renderer's
 * content.
 */
export function createStreamingPatchThrottle(opts: {
  chatId: number;
  send: SendPatchFn;
  throttleMs?: number;
  threshold?: number;
  logTag?: string;
}): StreamingPatchThrottle {
  const chatId = opts.chatId;
  const throttleMs = opts.throttleMs ?? IPC_STREAM_THROTTLE_MS;
  const threshold = opts.threshold ?? IPC_STREAM_BACKPRESSURE_THRESHOLD;
  const logTag = opts.logTag ?? "ipc-throttle";
  const send = opts.send;

  const coalescer = createPatchCoalescer();
  const backpressure: AckBackpressure = createAckBackpressure({
    chatId,
    threshold,
  });

  let trailingTimer: NodeJS.Timeout | null = null;
  let lastSentAt = 0;
  let destroyed = false;

  function clearTrailing(): void {
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
  }

  function flushPending(now: number): void {
    const patch = coalescer.drain();
    if (!patch) return;
    lastSentAt = now;
    const seq = backpressure.markSent();
    try {
      send(patch, seq);
    } catch (err) {
      logger.warn(`[${logTag}] send failed chat=${chatId} seq=${seq}`, err);
    }
  }

  /**
   * Send `pending` honoring the throttle window: fires immediately if the
   * window has elapsed, otherwise arms a trailing-edge timer. No-op when
   * nothing is pending or a timer is already armed.
   */
  function scheduleFlush(): void {
    if (destroyed || !coalescer.hasPending() || trailingTimer) return;
    const now = Date.now();
    const elapsed = now - lastSentAt;
    if (elapsed >= throttleMs) {
      flushPending(now);
      return;
    }
    const wait = throttleMs - elapsed;
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      if (coalescer.hasPending()) flushPending(Date.now());
    }, wait);
  }

  // Drain coalesced patch when ack pulls in-flight count back under threshold.
  backpressure.onResume(() => {
    if (coalescer.hasPending()) scheduleFlush();
  });

  return {
    queue(patch) {
      if (destroyed) return;
      coalescer.add(patch);
      if (backpressure.isHeld()) {
        // Renderer behind. Cancel any armed trailing send and let new
        // patches keep coalescing into the buffer. `onResume` resumes
        // the drain once an ack pulls backlog back under threshold.
        clearTrailing();
        return;
      }
      scheduleFlush();
    },

    cancel() {
      clearTrailing();
      coalescer.reset();
    },

    destroy(emitSummary = true) {
      if (destroyed) return;
      destroyed = true;
      clearTrailing();
      coalescer.reset();
      const { sent, acked, maxBacklog } = backpressure.stats();
      backpressure.destroy();
      if (emitSummary && sent > 0) {
        logger.log(
          `[${logTag}] summary chat=${chatId} sent=${sent} acked=${acked} maxBacklog=${maxBacklog} throttleMs=${throttleMs} threshold=${threshold}`,
        );
      }
    },
  };
}
