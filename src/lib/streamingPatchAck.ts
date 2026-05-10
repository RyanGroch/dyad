import { ipc } from "@/ipc/types";

/**
 * Debounce window for streaming-patch acks. Renderer-side coalescing — main
 * only needs the *latest* applied seq per chat to drive backpressure, so we
 * batch consecutive applies into one ack to avoid flooding the main process
 * during fast streams.
 */
const ACK_DEBOUNCE_MS = 50;

interface PendingAck {
  /** Highest applied seq seen since the last flushed ack. */
  seq: number;
  /** Timer handle for the trailing-edge flush. */
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingAck>();

/**
 * Record that the renderer has applied `seq` for `chatId`. Coalesces with
 * any in-flight pending ack (only the highest seq is sent). Fire-and-forget.
 *
 * No-op when `seq` is undefined (older main-process builds before
 * `StreamingPatchSchema` carried `seq`).
 */
export function ackStreamingPatchApplied(
  chatId: number,
  seq: number | undefined,
): void {
  if (seq === undefined) return;

  const existing = pending.get(chatId);
  if (existing) {
    if (seq > existing.seq) existing.seq = seq;
    return;
  }

  const timer = setTimeout(() => {
    const entry = pending.get(chatId);
    if (!entry) return;
    pending.delete(chatId);
    void ipc.chat.ackStreamingPatch({ chatId, seq: entry.seq }).catch(() => {
      // Swallow — main process may be shutting down or the channel may not
      // exist on older builds. Backlog telemetry is best-effort.
    });
  }, ACK_DEBOUNCE_MS);

  pending.set(chatId, { seq, timer });
}
