import React, { useDeferredValue, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { DyadWrite } from "./DyadWrite";
import { DyadRename } from "./DyadRename";
import { DyadCopy } from "./DyadCopy";
import { DyadDelete } from "./DyadDelete";
import { DyadAddDependency } from "./DyadAddDependency";
import { DyadExecuteSql } from "./DyadExecuteSql";
import { DyadLogs } from "./DyadLogs";
import { DyadGrep } from "./DyadGrep";
import { DyadAddIntegration } from "./DyadAddIntegration";
import { DyadEnableNitro } from "./DyadEnableNitro";
import { DyadEdit } from "./DyadEdit";
import { DyadSearchReplace } from "./DyadSearchReplace";
import { DyadCodebaseContext } from "./DyadCodebaseContext";
import { DyadThink } from "./DyadThink";
import { CodeHighlight } from "./CodeHighlight";
import { useAtomValue } from "jotai";
import { isStreamingByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { CustomTagState } from "./stateTypes";
import { DyadOutput } from "./DyadOutput";
import { DyadProblemSummary } from "./DyadProblemSummary";
import { ipc } from "@/ipc/types";
import { DyadMcpToolCall } from "./DyadMcpToolCall";
import { DyadMcpToolResult } from "./DyadMcpToolResult";
import { DyadWebSearchResult } from "./DyadWebSearchResult";
import { DyadWebSearch } from "./DyadWebSearch";
import { DyadWebCrawl } from "./DyadWebCrawl";
import { DyadWebFetch } from "./DyadWebFetch";
import { DyadImageGeneration } from "./DyadImageGeneration";
import { DyadCodeSearchResult } from "./DyadCodeSearchResult";
import { DyadCodeSearch } from "./DyadCodeSearch";
import { DyadRead } from "./DyadRead";
import { DyadListFiles } from "./DyadListFiles";
import { DyadDatabaseSchema } from "./DyadDatabaseSchema";
import { DyadDbTableSchema } from "./DyadDbTableSchema";
import { DyadSupabaseProjectInfo } from "./DyadSupabaseProjectInfo";
import { DyadNeonProjectInfo } from "./DyadNeonProjectInfo";
import { DyadStatus } from "./DyadStatus";
import { DyadCompaction } from "./DyadCompaction";
import { DyadWritePlan } from "./DyadWritePlan";
import { DyadExitPlan } from "./DyadExitPlan";
import { DyadQuestionnaire } from "./DyadQuestionnaire";
import { DyadStepLimit } from "./DyadStepLimit";
import { DyadReadGuide } from "./DyadReadGuide";
import { mapActionToButton } from "./ChatInput";
import { SuggestedAction } from "@/lib/schemas";
import { FixAllErrorsButton } from "./FixAllErrorsButton";
import { unescapeXmlAttr, unescapeXmlContent } from "../../../shared/xmlEscape";

const DYAD_CUSTOM_TAGS = [
  "dyad-write",
  "dyad-rename",
  "dyad-delete",
  "dyad-add-dependency",
  "dyad-execute-sql",
  "dyad-read-logs",
  "dyad-add-integration",
  "dyad-enable-nitro",
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
  "dyad-db-table-schema",
  "dyad-supabase-table-schema",
  "dyad-supabase-project-info",
  "dyad-neon-project-info",
  "dyad-neon-table-schema",
  "dyad-read-guide",
  "dyad-status",
  "dyad-compaction",
  "dyad-copy",
  "dyad-image-generation",
  // Plan mode tags
  "dyad-write-plan",
  "dyad-exit-plan",
  "dyad-questionnaire",
  // Step limit notification
  "dyad-step-limit",
];

interface DyadMarkdownParserProps {
  content: string;
}

type CustomTagInfo = {
  tag: string;
  attributes: Record<string, string>;
  content: string;
  fullMatch: string;
  inProgress?: boolean;
};

type ContentPiece =
  | { type: "markdown"; content: string }
  | { type: "custom-tag"; tagInfo: CustomTagInfo };

const customLink = ({
  node: _node,
  ...props
}: {
  node?: any;
  [key: string]: any;
}) => (
  <a
    {...props}
    onClick={(e) => {
      const url = props.href;
      if (url) {
        e.preventDefault();
        ipc.system.openExternalUrl(url);
      }
    }}
  />
);

export const VanillaMarkdownParser = ({ content }: { content: string }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeHighlight,
        a: customLink,
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

/**
 * Custom component to parse markdown content with Dyad-specific tags
 */
export const DyadMarkdownParser: React.FC<DyadMarkdownParserProps> = ({
  content,
}) => {
  const chatId = useAtomValue(selectedChatIdAtom);
  const isStreaming = useAtomValue(isStreamingByIdAtom).get(chatId!) ?? false;
  const deferredContent = useDeferredValue(content);
  const contentToParse = isStreaming ? deferredContent : content;

  // Per-instance incremental parser. Holds frozen completed pieces by ref so
  // historical message content is not re-walked on every streaming chunk and
  // is not retained via SlicedString parents on memoized React props.
  const parserRef = useRef<IncrementalParser | null>(null);
  if (parserRef.current === null) {
    parserRef.current = createIncrementalParser();
  }
  const contentPieces = parserRef.current.parse(contentToParse, isStreaming);

  // Extract error messages and track positions
  const { errorMessages, lastErrorIndex, errorCount } = useMemo(() => {
    const errors: string[] = [];
    let lastIndex = -1;
    let count = 0;

    contentPieces.forEach((piece, index) => {
      if (
        piece.type === "custom-tag" &&
        piece.tagInfo.tag === "dyad-output" &&
        piece.tagInfo.attributes.type === "error"
      ) {
        const errorMessage = piece.tagInfo.attributes.message;
        if (errorMessage?.trim()) {
          errors.push(errorMessage.trim());
          count++;
          lastIndex = index;
        }
      }
    });

    return {
      errorMessages: errors,
      lastErrorIndex: lastIndex,
      errorCount: count,
    };
  }, [contentPieces]);

  return (
    <>
      {contentPieces.map((piece, index) => (
        <React.Fragment key={index}>
          {piece.type === "markdown" ? (
            piece.content && <MemoMarkdown content={piece.content} />
          ) : (
            <MemoCustomTag tagInfo={piece.tagInfo} isStreaming={isStreaming} />
          )}
          {index === lastErrorIndex &&
            errorCount > 1 &&
            !isStreaming &&
            chatId && (
              <div className="mt-3 w-full flex">
                <FixAllErrorsButton
                  errorMessages={errorMessages}
                  chatId={chatId}
                />
              </div>
            )}
        </React.Fragment>
      ))}
    </>
  );
};

// Module-level constants so MemoMarkdown never gets fresh refs for these
// props, which would defeat ReactMarkdown's internal prop-equality checks.
const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = { code: CodeHighlight, a: customLink };

// Memoized markdown piece. Without this, ReactMarkdown re-parses every
// completed segment's text into an AST on every streaming chunk —
// the dominant per-render cost during long streams. Memoizing on
// `content` lets completed segments skip that re-parse entirely.
const MemoMarkdown = React.memo(function MemoMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

function tagInfoEqual(a: CustomTagInfo, b: CustomTagInfo): boolean {
  if (a.tag !== b.tag) return false;
  if (a.content !== b.content) return false;
  if (a.inProgress !== b.inProgress) return false;
  const aKeys = Object.keys(a.attributes);
  const bKeys = Object.keys(b.attributes);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a.attributes[k] !== b.attributes[k]) return false;
  }
  // fullMatch intentionally omitted: renderCustomTag never reads it, so two
  // tagInfo objects that differ only in fullMatch produce identical output.
  return true;
}

// Memoized custom-tag piece. parseCustomTags rebuilds tagInfo objects on
// every chunk (new refs), so React.memo's default referential equality
// would never hit. The custom comparator deep-checks the fields that
// actually affect the rendered output, so completed dyad tags skip
// renderCustomTag and the React subtree rebuild when only later pieces
// change.
const MemoCustomTag = React.memo(
  function MemoCustomTag({
    tagInfo,
    isStreaming,
  }: {
    tagInfo: CustomTagInfo;
    isStreaming: boolean;
  }) {
    return <>{renderCustomTag(tagInfo, { isStreaming })}</>;
  },
  (prev, next) =>
    tagInfoEqual(prev.tagInfo, next.tagInfo) &&
    // Completed tags don't use isStreaming (getState returns "finished"
    // regardless), so skip the check to avoid a one-time re-render of every
    // completed tag when streaming ends.
    (prev.tagInfo.inProgress === false ||
      prev.isStreaming === next.isStreaming),
);

// Sort tags longest-first so e.g. "dyad-read-guide" is tried before "dyad-read".
// The (?=[\s>]) lookahead ensures a tag name like "dyad-read" won't prefix-match
// "dyad-read-guide" (the char after must be whitespace or '>').
const SORTED_DYAD_TAGS = [...DYAD_CUSTOM_TAGS].sort(
  (a, b) => b.length - a.length,
);
const TAG_PATTERN_SOURCE = `<(${SORTED_DYAD_TAGS.join(
  "|",
)})(?=[\\s>])\\s*([^>]*)>(.*?)<\\/\\1>`;

function makeTagPattern(): RegExp {
  return new RegExp(TAG_PATTERN_SOURCE, "gs");
}

/**
 * Pre-process content to handle unclosed custom tags. Adds closing tags at the
 * end of the content for any unclosed custom tags. Optionally accepts seed
 * open/close counts that represent tags already accounted for in some frozen
 * prefix outside `content`, so this can be invoked on a tail slice and still
 * compute correct in-progress accounting.
 */
function preprocessUnclosedTags(
  content: string,
  seedOpens?: Map<string, number>,
  seedCloses?: Map<string, number>,
): {
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

    const localOpenCount = openingMatches.length;
    const localCloseCount = (processedContent.match(closeTagPattern) || [])
      .length;

    const totalOpens = (seedOpens?.get(tagName) ?? 0) + localOpenCount;
    const totalCloses = (seedCloses?.get(tagName) ?? 0) + localCloseCount;
    const missingCloseTags = totalOpens - totalCloses;

    if (missingCloseTags > 0) {
      processedContent += Array(missingCloseTags)
        .fill(`</${tagName}>`)
        .join("");

      const inProgressIndexes = new Set<number>();
      const startIndex = localOpenCount - missingCloseTags;
      for (let i = Math.max(0, startIndex); i < localOpenCount; i++) {
        inProgressIndexes.add(openingMatches[i].index);
      }
      inProgressTags.set(tagName, inProgressIndexes);
    }
  }

  return { processedContent, inProgressTags };
}

/**
 * Walk a preprocessed content string with the tag regex and emit pieces. All
 * extracted strings are .normalize()'d so they don't retain a V8 SlicedString
 * parent reference into the (potentially multi-MB) source string once the
 * piece is held by memoized React props.
 */
function extractPieces(
  processedContent: string,
  inProgressTags: Map<string, Set<number>>,
): ContentPiece[] {
  const tagPattern = makeTagPattern();
  const pieces: ContentPiece[] = [];
  let lastIndex = 0;
  let match;

  while ((match = tagPattern.exec(processedContent)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;

    if (startIndex > lastIndex) {
      pieces.push({
        type: "markdown",
        content: processedContent.substring(lastIndex, startIndex).normalize(),
      });
    }

    const attributes: Record<string, string> = {};
    const attrPattern = /([\w-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
      attributes[attrMatch[1]] = unescapeXmlAttr(attrMatch[2]).normalize();
    }

    const tagInProgressSet = inProgressTags.get(tag);
    const isInProgress = tagInProgressSet?.has(startIndex);

    pieces.push({
      type: "custom-tag",
      tagInfo: {
        tag,
        attributes,
        content: unescapeXmlContent(tagContent).normalize(),
        fullMatch: fullMatch.normalize(),
        inProgress: isInProgress || false,
      },
    });

    lastIndex = startIndex + fullMatch.length;
  }

  if (lastIndex < processedContent.length) {
    pieces.push({
      type: "markdown",
      content: processedContent.substring(lastIndex).normalize(),
    });
  }

  return pieces;
}

function accumulateTagCounts(
  span: string,
  opens: Map<string, number>,
  closes: Map<string, number>,
): void {
  for (const tagName of DYAD_CUSTOM_TAGS) {
    const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeRe = new RegExp(`</${tagName}>`, "g");
    const o = (span.match(openRe) || []).length;
    const c = (span.match(closeRe) || []).length;
    if (o) opens.set(tagName, (opens.get(tagName) ?? 0) + o);
    if (c) closes.set(tagName, (closes.get(tagName) ?? 0) + c);
  }
}

type IncrementalParser = {
  parse(content: string, isStreaming: boolean): ContentPiece[];
};

const FINGERPRINT_LEN = 64;

/**
 * Stateful parser that processes only the unfrozen tail of the content on
 * each call. Pieces for completed `<tag>...</tag>` pairs and the markdown
 * between them are committed once and kept by reference forever, so memoized
 * React subtrees skip re-render and — critically — those pieces no longer
 * pin the multi-MB streaming message buffer in memory via SlicedString
 * parent references.
 *
 * Reset is triggered when the content shrinks or its prefix fingerprint no
 * longer matches what was previously frozen (e.g. message edit/regen). The
 * parser does NOT retain a reference to prior full content, only short
 * fingerprint substrings.
 */
function createIncrementalParser(): IncrementalParser {
  const frozenPieces: ContentPiece[] = [];
  const frozenOpens = new Map<string, number>();
  const frozenCloses = new Map<string, number>();
  let frozenEnd = 0;
  let prevContentLength = 0;
  let prefixFingerprint = "";
  let frozenEndFingerprint = "";
  let cachedResult: ContentPiece[] | null = null;
  let cachedLength = -1;
  let cachedStreaming = false;

  function reset() {
    frozenPieces.length = 0;
    frozenOpens.clear();
    frozenCloses.clear();
    frozenEnd = 0;
    prevContentLength = 0;
    prefixFingerprint = "";
    frozenEndFingerprint = "";
    cachedResult = null;
    cachedLength = -1;
  }

  function fingerprintEndingAt(content: string, end: number): string {
    if (end <= 0) return "";
    const start = Math.max(0, end - FINGERPRINT_LEN);
    return content.substring(start, end).normalize();
  }

  function detectMismatch(content: string): boolean {
    if (content.length < prevContentLength) return true;
    if (prevContentLength === 0) return false;
    const prefixLen = Math.min(FINGERPRINT_LEN, content.length);
    const prefix = content.substring(0, prefixLen).normalize();
    if (prefix !== prefixFingerprint) return true;
    if (frozenEnd > 0) {
      if (fingerprintEndingAt(content, frozenEnd) !== frozenEndFingerprint) {
        return true;
      }
    }
    return false;
  }

  return {
    parse(content: string, isStreaming: boolean): ContentPiece[] {
      if (
        cachedResult !== null &&
        cachedLength === content.length &&
        cachedStreaming === isStreaming
      ) {
        return cachedResult;
      }

      if (detectMismatch(content)) {
        reset();
      }

      // Walk the tail looking for completed `<tag>...</tag>` matches we can
      // freeze. `tail` is sliced for the regex; everything pushed into
      // frozenPieces is .normalize()'d so V8 doesn't retain `tail`'s parent.
      const tail = content.substring(frozenEnd);
      const tagPattern = makeTagPattern();
      let lastTailIdx = 0;
      let match;
      while ((match = tagPattern.exec(tail)) !== null) {
        const [fullMatch, tag, attributesStr, tagContent] = match;
        const startIdx = match.index;
        const endIdx = startIdx + fullMatch.length;

        // While streaming, hold off freezing a tag that sits at the very end
        // of the buffer for one tick — keeps us from committing to a tag
        // shape the model could still be appending to. Once isStreaming is
        // false, freeze unconditionally.
        if (isStreaming && endIdx >= tail.length) {
          break;
        }

        if (startIdx > lastTailIdx) {
          const md = tail.substring(lastTailIdx, startIdx).normalize();
          frozenPieces.push({ type: "markdown", content: md });
          accumulateTagCounts(md, frozenOpens, frozenCloses);
        }

        const attributes: Record<string, string> = {};
        const attrPattern = /([\w-]+)="([^"]*)"/g;
        let attrMatch;
        while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
          attributes[attrMatch[1]] = unescapeXmlAttr(attrMatch[2]).normalize();
        }

        frozenPieces.push({
          type: "custom-tag",
          tagInfo: {
            tag,
            attributes,
            content: unescapeXmlContent(tagContent).normalize(),
            fullMatch: fullMatch.normalize(),
            inProgress: false,
          },
        });
        frozenOpens.set(tag, (frozenOpens.get(tag) ?? 0) + 1);
        frozenCloses.set(tag, (frozenCloses.get(tag) ?? 0) + 1);

        lastTailIdx = endIdx;
      }

      if (lastTailIdx > 0) {
        frozenEnd += lastTailIdx;
        frozenEndFingerprint = fingerprintEndingAt(content, frozenEnd);
      }

      // Hot tail: re-run the full pipeline on whatever's left. Output is
      // recomputed each call (these pieces are still in flux), but the work
      // is bounded to the in-progress region — the historical message
      // content above frozenEnd is never touched again.
      const hot = content.substring(frozenEnd);
      let tailPieces: ContentPiece[] = [];
      if (hot.length > 0) {
        const { processedContent, inProgressTags } = preprocessUnclosedTags(
          hot,
          frozenOpens,
          frozenCloses,
        );
        tailPieces = extractPieces(processedContent, inProgressTags);
      }

      const result =
        tailPieces.length === 0
          ? frozenPieces.slice()
          : frozenPieces.concat(tailPieces);

      prevContentLength = content.length;
      if (prefixFingerprint === "" && content.length > 0) {
        prefixFingerprint = content
          .substring(0, Math.min(FINGERPRINT_LEN, content.length))
          .normalize();
      }
      cachedResult = result;
      cachedLength = content.length;
      cachedStreaming = isStreaming;

      return result;
    },
  };
}

function getState({
  isStreaming,
  inProgress,
  explicitState,
}: {
  isStreaming?: boolean;
  inProgress?: boolean;
  explicitState?: string;
}): CustomTagState {
  if (explicitState === "aborted" || explicitState === "finished") {
    return explicitState;
  }
  if (explicitState === "in-progress" || explicitState === "pending") {
    return "pending";
  }
  if (!inProgress) {
    return "finished";
  }
  return isStreaming ? "pending" : "aborted";
}

/**
 * Render a custom tag based on its type
 */
function renderCustomTag(
  tagInfo: CustomTagInfo,
  { isStreaming }: { isStreaming: boolean },
): React.ReactNode {
  const { tag, attributes, content, inProgress } = tagInfo;

  switch (tag) {
    case "dyad-read":
      return (
        <DyadRead
          node={{
            properties: {
              path: attributes.path || "",
              startLine: attributes.start_line || "",
              endLine: attributes.end_line || "",
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </DyadRead>
      );
    case "dyad-web-search":
      return (
        <DyadWebSearch
          node={{
            properties: {
              query: attributes.query || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadWebSearch>
      );
    case "dyad-web-crawl":
      return (
        <DyadWebCrawl
          node={{
            properties: {},
          }}
        >
          {content}
        </DyadWebCrawl>
      );
    case "dyad-web-fetch":
      return (
        <DyadWebFetch
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadWebFetch>
      );
    case "dyad-code-search":
      return (
        <DyadCodeSearch
          node={{
            properties: {
              query: attributes.query || "",
              state: getState({ isStreaming, inProgress }),
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </DyadCodeSearch>
      );
    case "dyad-code-search-result":
      return (
        <DyadCodeSearchResult
          node={{
            properties: {},
          }}
        >
          {content}
        </DyadCodeSearchResult>
      );
    case "dyad-web-search-result":
      return (
        <DyadWebSearchResult
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadWebSearchResult>
      );
    case "think":
      return (
        <DyadThink
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadThink>
      );
    case "dyad-write":
      return (
        <DyadWrite
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadWrite>
      );

    case "dyad-rename":
      return (
        <DyadRename
          node={{
            properties: {
              from: attributes.from || "",
              to: attributes.to || "",
            },
          }}
        >
          {content}
        </DyadRename>
      );

    case "dyad-copy":
      return (
        <DyadCopy
          node={{
            properties: {
              from: attributes.from || "",
              to: attributes.to || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadCopy>
      );

    case "dyad-delete":
      return (
        <DyadDelete
          node={{
            properties: {
              path: attributes.path || "",
            },
          }}
        >
          {content}
        </DyadDelete>
      );

    case "dyad-add-dependency":
      return (
        <DyadAddDependency
          node={{
            properties: {
              packages: attributes.packages || "",
            },
          }}
        >
          {content}
        </DyadAddDependency>
      );

    case "dyad-execute-sql":
      return (
        <DyadExecuteSql
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              description: attributes.description || "",
            },
          }}
        >
          {content}
        </DyadExecuteSql>
      );

    case "dyad-read-logs":
      return (
        <DyadLogs
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              time: attributes.time || "",
              type: attributes.type || "",
              level: attributes.level || "",
              count: attributes.count || "",
            },
          }}
        >
          {content}
        </DyadLogs>
      );

    case "dyad-grep":
      return (
        <DyadGrep
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              query: attributes.query || "",
              include: attributes.include || "",
              exclude: attributes.exclude || "",
              "case-sensitive": attributes["case-sensitive"] || "",
              count: attributes.count || "",
              total: attributes.total || "",
              truncated: attributes.truncated || "",
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </DyadGrep>
      );

    case "dyad-add-integration":
      return (
        <DyadAddIntegration
          provider={
            attributes.provider === "neon" || attributes.provider === "supabase"
              ? attributes.provider
              : undefined
          }
        >
          {content}
        </DyadAddIntegration>
      );

    case "dyad-enable-nitro":
      return <DyadEnableNitro state={getState({ isStreaming, inProgress })} />;

    case "dyad-edit":
      return (
        <DyadEdit
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadEdit>
      );

    case "dyad-search-replace":
      return (
        <DyadSearchReplace
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadSearchReplace>
      );

    case "dyad-codebase-context":
      return (
        <DyadCodebaseContext
          node={{
            properties: {
              files: attributes.files || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadCodebaseContext>
      );

    case "dyad-mcp-tool-call":
      return (
        <DyadMcpToolCall
          node={{
            properties: {
              serverName: attributes.server || "",
              toolName: attributes.tool || "",
            },
          }}
        >
          {content}
        </DyadMcpToolCall>
      );

    case "dyad-mcp-tool-result":
      return (
        <DyadMcpToolResult
          node={{
            properties: {
              serverName: attributes.server || "",
              toolName: attributes.tool || "",
            },
          }}
        >
          {content}
        </DyadMcpToolResult>
      );

    case "dyad-output":
      return (
        <DyadOutput
          type={attributes.type as "warning" | "error"}
          message={attributes.message}
        >
          {content}
        </DyadOutput>
      );

    case "dyad-problem-report":
      return (
        <DyadProblemSummary summary={attributes.summary}>
          {content}
        </DyadProblemSummary>
      );

    case "dyad-chat-summary":
      // Don't render anything for dyad-chat-summary
      return null;

    case "dyad-command":
      if (attributes.type) {
        const action = {
          id: attributes.type,
        } as SuggestedAction;
        return <>{mapActionToButton(action)}</>;
      }
      return null;

    case "dyad-list-files":
      return (
        <DyadListFiles
          node={{
            properties: {
              directory: attributes.directory || "",
              recursive: attributes.recursive || "",
              include_ignored:
                attributes.include_ignored || attributes.include_hidden || "",
              state: getState({ isStreaming, inProgress }),
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </DyadListFiles>
      );

    case "dyad-database-schema":
      return (
        <DyadDatabaseSchema
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadDatabaseSchema>
      );

    case "dyad-db-table-schema":
    // Backward compat: old messages used provider-specific tags
    case "dyad-supabase-table-schema":
    case "dyad-neon-table-schema":
      return (
        <DyadDbTableSchema
          provider={
            tag === "dyad-supabase-table-schema"
              ? "Supabase"
              : tag === "dyad-neon-table-schema"
                ? "Neon"
                : (attributes.provider as string) || ""
          }
          node={{
            properties: {
              table: attributes.table || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadDbTableSchema>
      );

    case "dyad-supabase-project-info":
      return (
        <DyadSupabaseProjectInfo
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadSupabaseProjectInfo>
      );

    case "dyad-neon-project-info":
      return (
        <DyadNeonProjectInfo
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadNeonProjectInfo>
      );

    case "dyad-read-guide":
      return (
        <DyadReadGuide
          node={{
            properties: {
              name: attributes.name || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadReadGuide>
      );

    case "dyad-image-generation":
      return (
        <DyadImageGeneration
          node={{
            properties: {
              prompt: attributes.prompt || "",
              path: attributes.path || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadImageGeneration>
      );

    case "dyad-status":
      return (
        <DyadStatus
          node={{
            properties: {
              title: attributes.title || "Processing...",
              state: getState({
                isStreaming,
                inProgress,
                explicitState: attributes.state,
              }),
            },
          }}
        >
          {content}
        </DyadStatus>
      );

    case "dyad-compaction":
      return (
        <DyadCompaction
          node={{
            properties: {
              title: attributes.title || "Compacting conversation",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadCompaction>
      );

    case "dyad-write-plan":
      return (
        <DyadWritePlan
          node={{
            properties: {
              title: attributes.title || "Implementation Plan",
              summary: attributes.summary,
              complete: attributes.complete,
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadWritePlan>
      );

    case "dyad-exit-plan":
      return (
        <DyadExitPlan
          node={{
            properties: {
              notes: attributes.notes,
            },
          }}
        />
      );

    case "dyad-questionnaire":
      return <DyadQuestionnaire>{content}</DyadQuestionnaire>;

    case "dyad-step-limit":
      return (
        <DyadStepLimit
          node={{
            properties: {
              steps: attributes.steps,
              limit: attributes.limit,
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadStepLimit>
      );

    default:
      return null;
  }
}
