/**
 * Generic ack-based backpressure for chunked main→renderer IPC streams.
 *
 * Tracks `sent − acked` in-flight chunk count. When that exceeds the
 * configured threshold the producer is "held" and should stop sending.
 * Each ack lowers the in-flight count; once it drops back under threshold,
 * the optional `onResume` callback fires so the producer can drain.
 *
 * No watchdog: callers are expected to recover from a stalled ack channel
 * via end-of-stream cleanup (e.g. a full messages-replacement) rather than
 * forcing drains here.
 *
 * Per-chat registry lets the single `chat:response:ack` IPC handler route
 * acks to whichever active stream owns that chatId (canned test stream or
 * production throttle).
 */
export interface AckBackpressure {
  /**
   * Mark a chunk as sent and assign it the next monotonic seq. The caller
   * must embed the returned seq in the IPC payload so the renderer can
   * echo it back via ack.
   */
  markSent(): number;

  /** Update the highest acked seq. Called by the IPC ack handler. */
  recordAck(seq: number): void;

  /**
   * Roll back a `markSent()` whose subsequent `send` threw. Only undoes the
   * most recent reservation, and only if no later `markSent` followed and
   * the seq has not been acked. No-op otherwise — this is opportunistic
   * cleanup, not a generic undo. Without it a synchronous send failure
   * leaves `lastSentSeq` ahead of what the renderer ever received, so the
   * renderer can never ack that seq and backpressure stays inflated for
   * the rest of the stream.
   */
  unmarkSent(seq: number): void;

  /** True when in-flight count (sent − acked) is at or above threshold. */
  isHeld(): boolean;

  /** Subscribe to drain events fired when in-flight drops back under threshold. */
  onResume(cb: () => void): void;

  /** Snapshot of current backpressure stats. Useful for end-of-stream logging. */
  stats(): {
    sent: number;
    acked: number;
    maxBacklog: number;
  };

  /** Tear down and remove from the registry. Idempotent. */
  destroy(): void;
}

const backpressuresByChatId = new Map<number, AckBackpressure>();

/** Routes an ack from the renderer to whichever active backpressure owns `chatId`. */
export function recordAckForChat(chatId: number, seq: number): void {
  backpressuresByChatId.get(chatId)?.recordAck(seq);
}

export function createAckBackpressure(opts: {
  chatId: number;
  threshold: number;
}): AckBackpressure {
  const { chatId, threshold } = opts;

  let nextSeq = 1;
  let lastSentSeq = 0;
  let lastAckedSeq = 0;
  let maxBacklog = 0;
  let destroyed = false;
  const resumeCallbacks: Array<() => void> = [];

  // Replace any pre-existing instance for this chat — two streams shouldn't
  // overlap, but if one leaks (test teardown, crash before destroy) the new
  // one should own ack routing.
  const prior = backpressuresByChatId.get(chatId);
  if (prior) prior.destroy();

  const handle: AckBackpressure = {
    markSent() {
      const seq = nextSeq++;
      lastSentSeq = seq;
      const backlog = lastSentSeq - lastAckedSeq;
      if (backlog > maxBacklog) maxBacklog = backlog;
      return seq;
    },

    recordAck(seq) {
      if (destroyed || seq <= lastAckedSeq) return;
      // Clamp to lastSentSeq so a delayed ack from a previous stream on the
      // same chatId (seqs restart per instance) can't push lastAckedSeq past
      // sent — that would make sent − acked go negative and effectively
      // disable backpressure for many subsequent sends.
      const clamped = seq > lastSentSeq ? lastSentSeq : seq;
      if (clamped <= lastAckedSeq) return;
      const wasHeld = lastSentSeq - lastAckedSeq >= threshold;
      lastAckedSeq = clamped;
      const isHeldNow = lastSentSeq - lastAckedSeq >= threshold;
      if (wasHeld && !isHeldNow) {
        for (const cb of resumeCallbacks) cb();
      }
    },

    unmarkSent(seq) {
      if (destroyed) return;
      // Only roll back the most recent reservation, and only when nothing
      // has acked it. If another markSent has already followed, the
      // monotonic seq invariant we'd need to repair is non-local — leave
      // it alone.
      if (lastSentSeq === seq && lastAckedSeq < seq) {
        lastSentSeq = seq - 1;
        nextSeq = seq;
      }
    },

    isHeld() {
      return lastSentSeq - lastAckedSeq >= threshold;
    },

    onResume(cb) {
      resumeCallbacks.push(cb);
    },

    stats() {
      return { sent: lastSentSeq, acked: lastAckedSeq, maxBacklog };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      resumeCallbacks.length = 0;
      if (backpressuresByChatId.get(chatId) === handle) {
        backpressuresByChatId.delete(chatId);
      }
    },
  };

  backpressuresByChatId.set(chatId, handle);
  return handle;
}
