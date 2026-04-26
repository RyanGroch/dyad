import { cleanFullResponse } from "./cleanFullResponse";

const DYAD_TAG_OPEN = "<dyad-";

/**
 * Scans pendingTail and returns the index of the first code unit that is NOT
 * yet safe to finalize. Everything before this index can be promoted out of
 * the rewritable region; everything from this index onward must remain
 * mutable in case a later chunk completes an in-progress `<dyad-...>` opening
 * tag (which triggers attribute-value escaping in cleanFullResponse).
 */
export function findCommitBoundary(tail: string): number {
  let i = 0;
  while (i < tail.length) {
    const lt = tail.indexOf("<", i);
    if (lt === -1) return tail.length;
    const after = tail.slice(lt, lt + DYAD_TAG_OPEN.length);
    if (after.length < DYAD_TAG_OPEN.length) {
      // Suffix at end of tail is shorter than "<dyad-".
      if (DYAD_TAG_OPEN.startsWith(after)) {
        // Could still become "<dyad-" once more chars arrive — hold from here.
        return lt;
      }
      // Cannot become "<dyad-" (e.g. "<di") — safe to skip past this `<`.
      return tail.length;
    }
    if (after !== DYAD_TAG_OPEN) {
      // Not a dyad tag; skip this `<` and keep scanning.
      i = lt + 1;
      continue;
    }
    // Confirmed "<dyad-" at lt. Scan for terminating `>` outside quotes.
    let j = lt + DYAD_TAG_OPEN.length;
    let inQuote = false;
    let closed = false;
    while (j < tail.length) {
      const ch = tail[j];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ">" && !inQuote) {
        closed = true;
        j++;
        break;
      }
      j++;
    }
    if (!closed) {
      // Opening tag not yet terminated — hold from here.
      return lt;
    }
    i = j;
  }
  return tail.length;
}

export interface StreamingPatch {
  offset: number;
  content: string;
}

/**
 * Streams response text without retaining the full body in memory.
 *
 * Maintains only:
 *   - `finalizedLength`: total chars already promoted past the rewritable tail.
 *   - `pendingTail`:    bounded rewritable suffix (size of longest in-progress
 *                       `<dyad-...>` opening tag).
 *   - `unsavedFinalized`: chars finalized since the last drain — drained by
 *                       the caller to be appended to the database. After
 *                       drain, those chars exist only in the DB.
 *
 * The persisted message row in the database holds the authoritative finalized
 * prefix; this buffer never reconstructs the full response itself. Callers
 * that need the full response read it back from the DB and append
 * `pendingTail`.
 */
export class StreamingBuffer {
  private finalizedLength = 0;
  private pendingTail = "";
  private unsavedFinalized = "";

  getFinalizedLength(): number {
    return this.finalizedLength;
  }

  getPendingTail(): string {
    return this.pendingTail;
  }

  totalLength(): number {
    return this.finalizedLength + this.pendingTail.length;
  }

  isEmpty(): boolean {
    return this.finalizedLength === 0 && this.pendingTail.length === 0;
  }

  /**
   * Marks the buffer as already containing `length` chars of finalized
   * content (e.g. the completed output of a canned test stream that the
   * caller has persisted to the DB directly). The text itself is NOT
   * retained — the DB row is the source of truth.
   */
  seed(text: string): void {
    if (!text) return;
    this.finalizedLength += text.length;
  }

  /**
   * Appends `chunk` to pendingTail, runs cleanFullResponse on pendingTail,
   * captures the patch that should be emitted to the renderer, and then
   * promotes the finalizable prefix into `unsavedFinalized` (await
   * `drainUnsavedFinalized` to retrieve and clear that buffer).
   *
   * The capture-then-promote order matters: emit must reflect the pre-promote
   * finalizedLength so the renderer receives any retroactively-cleaned bytes
   * before this buffer considers them immutable.
   */
  processChunk(chunk: string): StreamingPatch {
    this.pendingTail += chunk;
    this.pendingTail = cleanFullResponse(this.pendingTail);
    const patch: StreamingPatch = {
      offset: this.finalizedLength,
      content: this.pendingTail,
    };
    const boundary = findCommitBoundary(this.pendingTail);
    if (boundary > 0) {
      const toFinalize = this.pendingTail.slice(0, boundary);
      this.unsavedFinalized += toFinalize;
      this.finalizedLength += toFinalize.length;
      this.pendingTail = this.pendingTail.slice(boundary);
    }
    return patch;
  }

  /**
   * Returns the chars finalized since the last drain and clears the internal
   * buffer. The caller is expected to append the returned string to the
   * persisted message row. Once drained, those chars exist only in the DB.
   */
  drainUnsavedFinalized(): string {
    const out = this.unsavedFinalized;
    this.unsavedFinalized = "";
    return out;
  }

  /**
   * Promotes the entire current pendingTail into the unsaved-finalized
   * buffer. Call only at a true end-of-stream point — once promoted, no
   * further `cleanFullResponse` rewrites can affect those chars.
   */
  finalizeRemaining(): void {
    if (this.pendingTail.length === 0) return;
    this.unsavedFinalized += this.pendingTail;
    this.finalizedLength += this.pendingTail.length;
    this.pendingTail = "";
  }
}
