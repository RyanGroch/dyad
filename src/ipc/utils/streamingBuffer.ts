import { cleanFullResponse } from "./cleanFullResponse";

const DYAD_TAG_OPEN = "<dyad-";

/**
 * Scans pendingTail and returns the index of the first code unit that is NOT
 * yet safe to finalize. Everything before this index can be promoted into the
 * immutable finalized array; everything from this index onward must remain
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
 * Accumulates streamed response text as an append-only array of finalized
 * chunks plus a small rewritable `pendingTail`. Avoids the O(N^2) per-chunk
 * flattening that happens when concatenating into a single `string`: each
 * per-chunk regex / slice / diff would force V8 to allocate a fresh
 * contiguous buffer sized to the whole accumulated response.
 *
 * pendingTail is bounded by the size of the longest in-progress `<dyad-...>`
 * opening tag — tag bodies stream straight into the finalized array without
 * buffering.
 */
export class StreamingBuffer {
  private finalized: string[] = [];
  private finalizedLength = 0;
  private pendingTail = "";

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
   * Seeds the buffer with pre-existing content (e.g. the completed output of
   * a canned test stream). Treated as finalized — no cleaning or boundary
   * tracking performed.
   */
  seed(text: string): void {
    if (!text) return;
    this.finalized.push(text);
    this.finalizedLength += text.length;
  }

  /**
   * Appends `chunk` to pendingTail, runs cleanFullResponse on pendingTail,
   * captures the patch that should be emitted to the renderer, and then
   * promotes the finalizable prefix into the finalized array.
   *
   * The capture-then-promote order matters: emit must reflect the pre-promote
   * finalizedLength so the renderer receives any retroactively-cleaned bytes
   * before this buffer considers them immutable. Promoting first would leave
   * the renderer with stale pre-clean bytes in the committed region.
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
      this.finalized.push(toFinalize);
      this.finalizedLength += toFinalize.length;
      this.pendingTail = this.pendingTail.slice(boundary);
    }
    return patch;
  }

  /**
   * Materializes the full accumulated response as a single string. Call at
   * boundaries where a downstream consumer requires a flat string (DB write,
   * dryRunSearchReplace, tag parsers, regex matching, final persist, etc.).
   * Each call is one O(N) allocation; do NOT call from a per-chunk hot path.
   */
  toString(): string {
    if (this.pendingTail.length === 0) {
      if (this.finalized.length === 0) return "";
      if (this.finalized.length === 1) return this.finalized[0];
    }
    return this.finalized.join("") + this.pendingTail;
  }
}
