import type { StreamingPatch } from "@/ipc/types";
import {
  advanceParserDelta,
  type ParserState,
} from "@/lib/streamingMessageParser";

/**
 * Apply a tail-only streaming patch directly to an incremental ParserState,
 * without ever reconstructing the full message string.
 *
 * The patch says the full response is now `prev.slice(0, offset) + content`.
 * Three cases against the parser's bounded open region [openBase, cursor):
 *
 *   - offset === cursor: a plain append. Feed `content` as the next delta.
 *   - openBase <= offset < cursor: a rewrite inside the still-open block
 *     (e.g. cleanFullResponse retroactively edits an in-progress tag's
 *     attributes). Replace the open region's tail and re-parse just that
 *     region from its committed-block boundary — committed blocks are
 *     untouched.
 *   - offset < openBase (rewrite reaches a committed block) or offset > cursor
 *     (a gap): cannot be applied locally; the caller should resync from the DB.
 *
 * prefixHash is intentionally not checked: the full prefix is never retained,
 * so it cannot be recomputed. The offset bounds above plus a DB resync on
 * `ok: false` cover base-mismatch detection.
 */
export interface PatchToParserResult {
  ok: boolean;
  state?: ParserState;
}

export function applyPatchToParserState(
  prev: ParserState,
  patch: StreamingPatch,
): PatchToParserResult {
  const { offset, content } = patch;

  if (offset === prev.cursor) {
    return { ok: true, state: advanceParserDelta(prev, content) };
  }

  if (offset >= prev.openBase && offset < prev.cursor) {
    const rel = offset - prev.openBase;
    const newOpenRaw = prev.openRaw.slice(0, rel) + content;
    return {
      ok: true,
      state: advanceParserDelta(rebaseToOpenRegion(prev), newOpenRaw),
    };
  }

  return { ok: false };
}

// A parser state holding only the committed blocks, positioned to re-parse the
// open region from scratch. The open region always begins at a committed-block
// boundary, which is always a fresh prose scan, so resetting to "prose" here is
// correct for both a markdown and a custom-tag boundary.
function rebaseToOpenRegion(prev: ParserState): ParserState {
  return {
    cursor: prev.openBase,
    openRaw: "",
    openBase: prev.openBase,
    mode: "prose",
    pending: "",
    pendingTagName: "",
    pendingAttrs: "",
    pendingCloseName: "",
    currentTag: null,
    tagStartOffset: prev.openBase,
    openBlock: null,
    blocks: prev.blocks,
    nextBlockId: prev.nextBlockId,
  };
}
