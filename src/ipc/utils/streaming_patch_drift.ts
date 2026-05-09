import log from "electron-log";
import type { StreamingPatch } from "@/ipc/types";

const logger = log.scope("streaming_patch_drift");

// How often to log live backlog stats while a stream is active.
// Set to 0 to disable mid-stream logs (end-of-stream summary still fires).
export const DRIFT_LOG_INTERVAL_MS = 250;

interface DriftStats {
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
 * find the right tracker to record acks against without threading the
 * instance through every IPC handler.
 */
const trackersByChatId = new Map<number, StreamingPatchDriftTracker>();

export function recordAckForChat(chatId: number, seq: number): void {
  trackersByChatId.get(chatId)?.recordAck(seq);
}

/**
 * Measures drift between the patch the main process has *sent* and the
 * patch the renderer has *finished applying*. Pure telemetry — does not
 * throttle, coalesce, or otherwise alter the outbound chunk stream.
 *
 * Lifecycle:
 *   - Construct one tracker per stream. `tag(patch)` assigns a monotonic
 *     `seq` and the caller forwards the result over IPC unmodified.
 *   - Renderer applies the patch and acks the highest applied `seq` on
 *     `chat:response:chunk:ack`; `recordAck` updates the tracker.
 *   - `destroy()` stops the periodic log timer and emits a final
 *     end-of-stream backlog summary.
 */
export class StreamingPatchDriftTracker {
  private nextSeq = 1;
  private logTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private readonly chatId: number;
  private readonly logTag: string;
  private readonly stats: DriftStats = {
    sent: 0,
    acked: 0,
    lastSentSeq: 0,
    lastAckedSeq: 0,
    maxBacklog: 0,
    backlogSamples: 0,
    backlogSum: 0,
  };

  constructor(opts: { chatId: number; logTag?: string }) {
    this.chatId = opts.chatId;
    this.logTag = opts.logTag ?? "drift";

    // Replace any pre-existing tracker for this chatId. Two streams for
    // the same chat shouldn't overlap, but if one leaks (test teardown,
    // crash before destroy) we want the new one to take over rather than
    // route acks to a dead instance.
    const prior = trackersByChatId.get(this.chatId);
    if (prior && prior !== this) {
      prior.destroy(false);
    }
    trackersByChatId.set(this.chatId, this);

    if (DRIFT_LOG_INTERVAL_MS > 0) {
      this.logTimer = setInterval(() => {
        this.sampleBacklog();
        this.logBacklog("mid-stream");
      }, DRIFT_LOG_INTERVAL_MS);
    }
  }

  /**
   * Stamps `patch` with the next monotonic seq and increments sent counters.
   * Returns the same patch object (mutated) so the caller can pass it
   * straight to `safeSend` without an extra spread.
   */
  tag(patch: StreamingPatch): StreamingPatch {
    const seq = this.nextSeq++;
    patch.seq = seq;
    this.stats.sent++;
    this.stats.lastSentSeq = seq;
    return patch;
  }

  recordAck(seq: number): void {
    if (seq <= this.stats.lastAckedSeq) return;
    this.stats.lastAckedSeq = seq;
    this.stats.acked++;
  }

  destroy(emitSummary = true): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
    if (trackersByChatId.get(this.chatId) === this) {
      trackersByChatId.delete(this.chatId);
    }
    if (emitSummary) {
      this.sampleBacklog();
      this.logBacklog("end-of-stream");
    }
  }

  private sampleBacklog(): void {
    const backlog = this.stats.lastSentSeq - this.stats.lastAckedSeq;
    this.stats.backlogSamples++;
    this.stats.backlogSum += backlog;
    if (backlog > this.stats.maxBacklog) {
      this.stats.maxBacklog = backlog;
    }
  }

  private logBacklog(kind: "mid-stream" | "end-of-stream"): void {
    const { stats } = this;
    const backlog = stats.lastSentSeq - stats.lastAckedSeq;
    const avgBacklog =
      stats.backlogSamples > 0 ? stats.backlogSum / stats.backlogSamples : 0;
    logger.info(
      `[${this.logTag}] chat=${this.chatId} ${kind} ` +
        `sent=${stats.sent} acked=${stats.acked} ` +
        `lastSentSeq=${stats.lastSentSeq} lastAckedSeq=${stats.lastAckedSeq} ` +
        `backlog=${backlog} maxBacklog=${stats.maxBacklog} ` +
        `avgBacklog=${avgBacklog.toFixed(2)}`,
    );
  }
}
