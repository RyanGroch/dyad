import { unescapeXmlAttr, unescapeXmlContent } from "../../shared/xmlEscape";

export const DYAD_CUSTOM_TAGS = [
  "dyad-write",
  "dyad-rename",
  "dyad-delete",
  "dyad-add-dependency",
  "dyad-execute-sql",
  "dyad-read-logs",
  "dyad-add-integration",
  "dyad-output",
  "dyad-problem-report",
  "dyad-chat-summary",
  "dyad-edit",
  "dyad-grep",
  "dyad-search-replace",
  "dyad-codebase-context",
  "dyad-web-search-result",
  "dyad-web-search",
  "dyad-web-crawl",
  "dyad-web-fetch",
  "dyad-code-search-result",
  "dyad-code-search",
  "dyad-read",
  "think",
  "dyad-command",
  "dyad-mcp-tool-call",
  "dyad-mcp-tool-result",
  "dyad-list-files",
  "dyad-database-schema",
  "dyad-supabase-table-schema",
  "dyad-supabase-project-info",
  "dyad-status",
  "dyad-compaction",
  "dyad-copy",
  "dyad-image-generation",
  "dyad-write-plan",
  "dyad-exit-plan",
  "dyad-questionnaire",
  "dyad-step-limit",
];

export type CustomTagInfo = {
  tag: string;
  attributes: Record<string, string>;
  content: string;
  fullMatch: string;
  inProgress?: boolean;
};

export type ContentPiece =
  | { type: "markdown"; content: string; _start: number; _end: number }
  | {
      type: "custom-tag";
      tagInfo: CustomTagInfo;
      _start: number;
      _end: number;
    };

function preprocessUnclosedTags(content: string): {
  processedContent: string;
  inProgressTags: Map<string, Set<number>>;
} {
  let processedContent = content;
  const inProgressTags = new Map<string, Set<number>>();

  for (const tagName of DYAD_CUSTOM_TAGS) {
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</${tagName}>`, "g");

    const openingMatches: RegExpExecArray[] = [];
    let match;
    openTagPattern.lastIndex = 0;
    while ((match = openTagPattern.exec(processedContent)) !== null) {
      openingMatches.push({ ...match });
    }

    const openCount = openingMatches.length;
    const closeCount = (processedContent.match(closeTagPattern) || []).length;

    const missingCloseTags = openCount - closeCount;
    if (missingCloseTags > 0) {
      processedContent += Array(missingCloseTags)
        .fill(`</${tagName}>`)
        .join("");

      const inProgressIndexes = new Set<number>();
      const startIndex = openCount - missingCloseTags;
      for (let i = startIndex; i < openCount; i++) {
        inProgressIndexes.add(openingMatches[i].index);
      }
      inProgressTags.set(tagName, inProgressIndexes);
    }
  }

  return { processedContent, inProgressTags };
}

/**
 * Parse content into a flat array of markdown chunks and dyad custom-tag
 * pieces. `_start`/`_end` are absolute offsets into the original (pre-preprocess)
 * content; the incremental cache uses these to decide which pieces are
 * immutable past `safeBoundary`.
 *
 * `safeBoundary` is the absolute offset up to which the returned pieces are
 * stable as more content is appended. Backs off past in-progress tag opens
 * and unmatched trailing `<`.
 */
export function parseCustomTags(
  content: string,
  baseOffset: number,
): { pieces: ContentPiece[]; safeBoundary: number } {
  const { processedContent, inProgressTags } = preprocessUnclosedTags(content);

  const tagPattern = new RegExp(
    `<(${DYAD_CUSTOM_TAGS.join("|")})\\s*([^>]*)>(.*?)<\\/\\1>`,
    "gs",
  );

  const contentPieces: ContentPiece[] = [];
  let lastIndex = 0;
  let match;

  while ((match = tagPattern.exec(processedContent)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;

    if (startIndex > lastIndex) {
      contentPieces.push({
        type: "markdown",
        content: processedContent.substring(lastIndex, startIndex),
        _start: baseOffset + lastIndex,
        _end: baseOffset + startIndex,
      });
    }

    const attributes: Record<string, string> = {};
    const attrPattern = /([\w-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
      attributes[attrMatch[1]] = unescapeXmlAttr(attrMatch[2]);
    }

    const tagInProgressSet = inProgressTags.get(tag);
    const isInProgress = tagInProgressSet?.has(startIndex);

    contentPieces.push({
      type: "custom-tag",
      tagInfo: {
        tag,
        attributes,
        content: unescapeXmlContent(tagContent),
        fullMatch,
        inProgress: isInProgress || false,
      },
      _start: baseOffset + startIndex,
      _end: baseOffset + startIndex + fullMatch.length,
    });

    lastIndex = startIndex + fullMatch.length;
  }

  if (lastIndex < processedContent.length) {
    contentPieces.push({
      type: "markdown",
      content: processedContent.substring(lastIndex),
      _start: baseOffset + lastIndex,
      _end: baseOffset + processedContent.length,
    });
  }

  let safeLocal = content.length;
  for (const set of inProgressTags.values()) {
    for (const idx of set) {
      if (idx < safeLocal) safeLocal = idx;
    }
  }
  const lastLT = content.lastIndexOf("<");
  if (lastLT !== -1 && content.indexOf(">", lastLT) === -1) {
    if (lastLT < safeLocal) safeLocal = lastLT;
  }

  return { pieces: contentPieces, safeBoundary: baseOffset + safeLocal };
}
