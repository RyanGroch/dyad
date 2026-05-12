import { ipc } from "@/ipc/types";

/**
 * Renderer-side throttled ack scheduler for chat-response chunk seqs.
 *
 * Coalesces consecutive applied seqs per chatId into one ack per throttle
 * window — main only needs the *latest* seq to drive its backpressure, so
 * batching avoids flooding the IPC channel during fast streams.
 *
 * Used by both the canned test stream path (in `useStreamChat.onChunk`)
 * and the production throttle path (which carries the same `chunkSeq`
 * top-level field on each chunk).
 */
const ACK_THROTTLE_MS = 250;

const latestSeqByChatId = new Map<number, number>();
const timerByChatId = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Record an applied seq for a chat. Schedules a throttled ack flush.
 * No-op when `seq` is undefined (chunks with no seq don't need acking).
 */
export function recordChunkApplied(
  chatId: number,
  seq: number | undefined,
): void {
  if (seq === undefined) return;
  const prev = latestSeqByChatId.get(chatId) ?? 0;
  if (seq > prev) latestSeqByChatId.set(chatId, seq);
  if (timerByChatId.has(chatId)) return;
  const timer = setTimeout(() => {
    timerByChatId.delete(chatId);
    const lastSeq = latestSeqByChatId.get(chatId);
    if (lastSeq === undefined) return;
    void ipc.chat.responseAck({ chatId, lastSeq }).catch((err) => {
      // Acks are advisory; main has no retry path. Log so a misbehaving
      // IPC channel is visible in devtools instead of failing silently.
      console.error("chat.responseAck failed", { chatId, lastSeq, err });
    });
  }, ACK_THROTTLE_MS);
  timerByChatId.set(chatId, timer);
}

/**
 * Cancel any pending ack timer and forget the latest-seq state for a chat.
 * Call on stream end (renderer-side onEnd/onError) to release resources.
 */
export function cancelChunkAcks(chatId: number): void {
  const timer = timerByChatId.get(chatId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timerByChatId.delete(chatId);
  }
  latestSeqByChatId.delete(chatId);
}
