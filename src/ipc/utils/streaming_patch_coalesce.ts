import type { StreamingPatch } from "@/ipc/types";

/**
 * Pure StreamingPatch merge buffer. Holds at most one pending patch and
 * merges any new patch into it. No timers, no IPC, no backpressure — just
 * the merge math, suitable for layering under a throttle or backpressure
 * gate.
 *
 * Coalesce semantics mirror the renderer's reconstruction
 * (`current.slice(0, offset) + content`):
 *   - If the new patch's offset is lower than the pending patch's, the
 *     newer patch fully supersedes (its tail rewrote bytes earlier than
 *     where the pending patch began).
 *   - Otherwise the merged patch keeps the lower offset and concatenates
 *     the older pending content's prefix with the newer content. The
 *     older patch's `prefixHash` wins — it describes the authoritative
 *     agreed-upon prefix at that offset.
 */
export interface PatchCoalescer {
  /** Merge a new patch into the pending buffer. */
  add(patch: StreamingPatch): void;

  /** Return and clear the merged pending patch, or null if none. */
  drain(): StreamingPatch | null;

  /** Drop the pending patch without returning it. */
  reset(): void;

  /** True when a pending patch is buffered. */
  hasPending(): boolean;
}

export function createPatchCoalescer(): PatchCoalescer {
  let pending: StreamingPatch | null = null;

  return {
    add(next) {
      if (!pending) {
        pending = { ...next };
        return;
      }
      if (next.offset < pending.offset) {
        pending = { ...next };
        return;
      }
      const prefixLen = next.offset - pending.offset;
      pending = {
        offset: pending.offset,
        content: pending.content.slice(0, prefixLen) + next.content,
        prefixHash: pending.prefixHash,
      };
    },
    drain() {
      const out = pending;
      pending = null;
      return out;
    },
    reset() {
      pending = null;
    },
    hasPending() {
      return pending !== null;
    },
  };
}
