// Incrementally builds the cleaned streaming response without ever re-scanning
// or re-allocating the whole string. It splits content into:
//   - settled: finalized, cleaned bytes (append-only; never re-processed)
//   - tail:    the small unsettled region (a partial "<" being disambiguated,
//              or an in-progress "<dyad-...>" opening tag)
//
// cleanFullResponse only ever rewrites complete "<dyad-...>" opening tags, so
// cleaning each tag in isolation is byte-identical to cleaning the whole string
// (verified by a property test). Patches are emitted O(delta) via a stable
// offset + rolling djb2 hash, matching the StreamingPatch the renderer expects.
import type { StreamingPatch } from "@/ipc/types";
import { cleanFullResponse } from "./cleanFullResponse";

const DYAD_OPEN_PREFIX = "<dyad-";

function djb2Extend(hash: number, s: string, from: number, to: number): number {
  let h = hash;
  for (let i = from; i < to; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function createStreamProcessor() {
  // Finalized cleaned content. Append-only.
  let settled = "";
  // Unsettled region: either a partial "<..." (mode "prose") or an in-progress
  // "<dyad-...>" opening tag (mode "tag").
  let work = "";
  let mode: "prose" | "tag" = "prose";
  let inQuote = false; // inside a "..." attribute value while in tag mode

  // Patch bookkeeping.
  let confirmedLen = 0; // settled bytes the renderer already has
  let runningHash = 5381; // djb2 of settled[0..confirmedLen]
  // Newly-settled bytes not yet sent. Kept separately so takePatch never has to
  // slice/read `settled` (which would flatten the cons-string — O(n) per send,
  // the dominant GC cost at large sizes). `settled` is write-only mid-stream.
  let pendingSend = "";

  // Settle a run of bytes verbatim (prose / tag body — clean never touches it).
  function settle(text: string): void {
    settled += text;
    pendingSend += text;
  }

  // True if `work` (which starts with "<") could still become "<dyad-".
  function couldBeDyadOpen(): boolean {
    return DYAD_OPEN_PREFIX.startsWith(work);
  }

  function push(chunk: string): void {
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      if (mode === "prose") {
        if (work.length > 0) {
          // Disambiguating a pending "<...": consume one char at a time until
          // we know whether it's "<dyad-" or ordinary text.
          work += chunk[i++];
          if (work === DYAD_OPEN_PREFIX) {
            mode = "tag";
            inQuote = false;
            // keep `work` as the start of the tag
          } else if (!couldBeDyadOpen()) {
            // Not a dyad tag: the leading "<...(prefix)" is ordinary prose.
            // Settle everything except a possible new "<" that just arrived.
            const lastLt = work.lastIndexOf("<");
            if (lastLt > 0) {
              settle(work.slice(0, lastLt));
              work = work.slice(lastLt); // a fresh "<..." to disambiguate
            } else if (lastLt === 0) {
              // still a "<..." prefix that diverged only after the "<"; settle
              // the diverged text, keep nothing pending.
              settle(work);
              work = "";
            } else {
              settle(work);
              work = "";
            }
          }
          continue;
        }
        // No pending "<": fast-forward prose up to the next "<".
        let j = i;
        while (j < n && chunk[j] !== "<") j++;
        if (j > i) settle(chunk.slice(i, j));
        if (j < n) {
          work = "<";
          i = j + 1;
        } else {
          i = j;
        }
      } else {
        // tag mode: accumulate until the closing ">" outside quotes.
        const ch = chunk[i++];
        work += ch;
        if (ch === '"') {
          inQuote = !inQuote;
        } else if (ch === ">" && !inQuote) {
          // Complete opening tag — clean it in isolation (byte-identical to
          // cleaning it within the full string) and settle.
          settle(cleanFullResponse(work));
          work = "";
          mode = "prose";
          inQuote = false;
        }
      }
    }
  }

  // The cleaned content the renderer should currently show = settled + the
  // unsettled tail (an in-progress tag / partial "<" is shown raw, exactly as
  // the old whole-string cleanFullResponse left it).
  function getFullContent(): string {
    return settled + work;
  }

  // Emit a tail-only patch for everything not yet confirmed. The stable prefix
  // is `settled` (append-only, never rewritten); `work` is volatile and resent
  // each time. Returns null when nothing changed since the last patch.
  function takePatch(): StreamingPatch | null {
    const content = pendingSend + work;
    if (content.length === 0) return null;
    const offset = confirmedLen;
    const prefixHash = offset > 0 ? runningHash : undefined;
    // Confirm the settled bytes (work stays unconfirmed/volatile). Hash only the
    // small pendingSend buffer — never re-read `settled`.
    runningHash = djb2Extend(runningHash, pendingSend, 0, pendingSend.length);
    confirmedLen += pendingSend.length;
    pendingSend = "";
    return { offset, content, prefixHash };
  }

  return { push, getFullContent, takePatch };
}
