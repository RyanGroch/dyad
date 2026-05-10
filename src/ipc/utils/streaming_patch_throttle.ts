import log from "electron-log";
import type { StreamingPatch } from "@/ipc/types";

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
// patch instead of many small ones). No watchdog: if acks never arrive
// the stream's end-of-stream full messages-replacement still delivers the
// authoritative final content, so renderer can't get stuck on stale state.
export const IPC_STREAM_BACKPRESSURE_THRESHOLD = 20;

export type SendPatchFn = (patch: StreamingPatch & { seq: number }) => void;

interface ThrottleStats {
  sent: number;
  acked: number;
  lastSentSeq: number;
  lastAckedSeq: number;
  maxBacklog: number;
  backlogSamples: number;
  backlogSum: number;
}

/**
 * Per-chat registry so the renderer's `chat:response:chunk:ack` handler can
 * find the right throttle to record acks against without threading the
 * instance through every IPC handler.
 */
const throttlesByChatId = new Map<number, StreamingPatchThrottle>();

export function recordAckForChat(chatId: number, seq: number): void {
  throttlesByChatId.get(chatId)?.recordAck(seq);
}

/**
 * Throttles outbound `chat:response:chunk` patch sends to the renderer.
 *
 * - Leading-edge: if the throttle window has elapsed and no trailing
 *   timer is armed, the patch ships immediately.
 * - Trailing-edge: otherwise the patch is coalesced into a single pending
 *   patch and a timer is armed to fire at window's end.
 *
 * The main process's stream-reading loop is never blocked: new patches just
 * land in `pending` while the renderer catches up.
 *
 * Coalesce math mirrors the renderer's reconstruction
 * (`current.slice(0, offset) + content`): the merged patch keeps the lower
 * offset and concatenates the older pending content's prefix with the
 * newer content. `prefixHash` of the older patch wins (it describes the
 * authoritative agreed-upon prefix at that offset).
 *
 * `cancel()` MUST be called before any full messages-array replacement
 * is sent on the same channel — a stale tail patch firing after a
 * messages-replacement gets reapplied against the wrong base and
 * truncates the renderer's content.
 */
export class StreamingPatchThrottle {
  private pending: StreamingPatch | null = null;
  private trailingTimer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private nextSeq = 1;
  private destroyed = false;
  private readonly chatId: number;
  private readonly send: SendPatchFn;
  private readonly throttleMs: number;
  private readonly logTag: string;
  private readonly stats: ThrottleStats = {
    sent: 0,
    acked: 0,
    lastSentSeq: 0,
    lastAckedSeq: 0,
    maxBacklog: 0,
    backlogSamples: 0,
    backlogSum: 0,
  };

  constructor(opts: {
    chatId: number;
    send: SendPatchFn;
    throttleMs?: number;
    logTag?: string;
  }) {
    this.chatId = opts.chatId;
    this.send = opts.send;
    this.throttleMs = opts.throttleMs ?? IPC_STREAM_THROTTLE_MS;
    this.logTag = opts.logTag ?? "ipc-throttle";

    // Replace any pre-existing throttle for this chatId. Two streams for
    // the same chat shouldn't overlap, but if one leaks (test teardown,
    // crash before destroy) we want the new one to take over rather than
    // route acks to a dead instance.
    const prior = throttlesByChatId.get(this.chatId);
    if (prior && prior !== this) {
      prior.destroy(false);
    }
    throttlesByChatId.set(this.chatId, this);
  }

  queue(patch: StreamingPatch): void {
    if (this.destroyed) return;
    this.coalesce(patch);

    const backlog = this.stats.lastSentSeq - this.stats.lastAckedSeq;
    if (backlog >= IPC_STREAM_BACKPRESSURE_THRESHOLD) {
      // Renderer behind. Cancel any armed trailing send and let new
      // patches keep coalescing into `pending`. `recordAck` resumes the
      // drain once an ack pulls backlog back under the threshold.
      if (this.trailingTimer) {
        clearTimeout(this.trailingTimer);
        this.trailingTimer = null;
      }
      return;
    }

    this.scheduleFlush();
  }

  /**
   * Sends `pending` honoring the throttle window: fires immediately if the
   * window has elapsed, otherwise arms a trailing-edge timer. No-op when
   * nothing is pending or a timer is already armed.
   */
  private scheduleFlush(): void {
    if (!this.pending || this.trailingTimer) return;
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed >= this.throttleMs) {
      this.flushPending(now);
      return;
    }
    const wait = this.throttleMs - elapsed;
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null;
      if (this.pending) this.flushPending(Date.now());
    }, wait);
  }

  /** Force-send any pending patch immediately. Idempotent. */
  flushNow(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    if (this.pending) this.flushPending(Date.now());
  }

  /** Drop any pending patch without sending. Use before full-messages-replacement. */
  cancel(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.pending = null;
  }

  recordAck(seq: number): void {
    if (seq <= this.stats.lastAckedSeq) return;
    this.stats.lastAckedSeq = seq;
    this.stats.acked = seq;
    this.sampleBacklog();

    // Backpressure release: ack just pulled in-flight count under the
    // threshold. Drain whatever has been coalescing while we held — one
    // larger merged patch rather than many small ones.
    if (
      this.pending &&
      this.stats.lastSentSeq - this.stats.lastAckedSeq <
        IPC_STREAM_BACKPRESSURE_THRESHOLD
    ) {
      this.scheduleFlush();
    }
  }

  /** Tear down and emit a one-shot end-of-stream summary. Call once at stream end. */
  destroy(emitSummary: boolean = true): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    if (throttlesByChatId.get(this.chatId) === this) {
      throttlesByChatId.delete(this.chatId);
    }
    if (emitSummary && this.stats.sent > 0) {
      const avg = this.stats.backlogSamples
        ? (this.stats.backlogSum / this.stats.backlogSamples).toFixed(2)
        : "0";
      logger.log(
        `[${this.logTag}] summary chat=${this.chatId} sent=${this.stats.sent} acked=${this.stats.acked} maxBacklog=${this.stats.maxBacklog} avgBacklog=${avg} throttleMs=${this.throttleMs}`,
      );
    }
  }

  private coalesce(next: StreamingPatch): void {
    if (!this.pending) {
      this.pending = { ...next };
      return;
    }
    if (next.offset < this.pending.offset) {
      // Newer patch rewrote bytes earlier than where the pending patch
      // started — its content is the authoritative new tail.
      this.pending = { ...next };
      return;
    }
    const prefixLen = next.offset - this.pending.offset;
    this.pending = {
      offset: this.pending.offset,
      content: this.pending.content.slice(0, prefixLen) + next.content,
      prefixHash: this.pending.prefixHash,
    };
  }

  private flushPending(now: number): void {
    const patch = this.pending;
    if (!patch) return;
    this.pending = null;
    this.lastSentAt = now;
    const seq = this.nextSeq++;
    this.stats.sent++;
    this.stats.lastSentSeq = seq;
    try {
      this.send({ ...patch, seq });
    } catch (err) {
      logger.warn(
        `[${this.logTag}] send failed chat=${this.chatId} seq=${seq}`,
        err,
      );
    }
    this.sampleBacklog();
  }

  private sampleBacklog(): void {
    const backlog = Math.max(
      0,
      this.stats.lastSentSeq - this.stats.lastAckedSeq,
    );
    if (backlog > this.stats.maxBacklog) this.stats.maxBacklog = backlog;
    this.stats.backlogSum += backlog;
    this.stats.backlogSamples++;
  }
}
