import {
  parseCustomTags,
  type ContentPiece,
} from "@/shared/dyadTagParser";

export interface SegmentedPiece {
  pieceIndex: number;
  type: string;
  content: string;
  attributesJson: Record<string, string> | null;
  byteStart: number;
  byteEnd: number;
  estHeightPx: number;
}

const HIDDEN_DYAD_TAGS = new Set(["dyad-chat-summary"]);

function estimateHeightPx(piece: ContentPiece): number {
  if (piece.type === "markdown") {
    const lines = Math.max(1, piece.content.split("\n").length);
    return Math.min(2000, Math.max(40, lines * 22));
  }
  switch (piece.tagInfo.tag) {
    case "dyad-write":
    case "dyad-edit":
    case "dyad-search-replace":
      return 120;
    case "think":
      return 80;
    case "dyad-output":
      return 100;
    default:
      return 80;
  }
}

/**
 * Convert a fully-finalized message body into segmented pieces ready for
 * insertion into `message_pieces`. Hidden tags (dyad-chat-summary) are skipped
 * to avoid 0-height rows in the renderer window.
 */
export function segmentMessageContent(content: string): SegmentedPiece[] {
  const { pieces } = parseCustomTags(content, 0);
  const out: SegmentedPiece[] = [];
  let pieceIndex = 0;
  for (const piece of pieces) {
    if (piece.type === "markdown") {
      if (!piece.content.trim()) continue;
      out.push({
        pieceIndex: pieceIndex++,
        type: "markdown",
        content: piece.content,
        attributesJson: null,
        byteStart: piece._start,
        byteEnd: piece._end,
        estHeightPx: estimateHeightPx(piece),
      });
    } else {
      if (HIDDEN_DYAD_TAGS.has(piece.tagInfo.tag)) continue;
      out.push({
        pieceIndex: pieceIndex++,
        type: piece.tagInfo.tag,
        content: piece.tagInfo.content,
        attributesJson: piece.tagInfo.attributes,
        byteStart: piece._start,
        byteEnd: piece._end,
        estHeightPx: estimateHeightPx(piece),
      });
    }
  }
  return out;
}
