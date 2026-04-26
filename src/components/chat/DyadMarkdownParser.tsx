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
import { DyadSupabaseTableSchema } from "./DyadSupabaseTableSchema";
import { DyadSupabaseProjectInfo } from "./DyadSupabaseProjectInfo";
import { DyadStatus } from "./DyadStatus";
import { DyadCompaction } from "./DyadCompaction";
import { DyadWritePlan } from "./DyadWritePlan";
import { DyadExitPlan } from "./DyadExitPlan";
import { DyadQuestionnaire } from "./DyadQuestionnaire";
import { DyadStepLimit } from "./DyadStepLimit";
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
  | { type: "markdown"; content: string; _start: number; _end: number }
  | {
      type: "custom-tag";
      tagInfo: CustomTagInfo;
      _start: number;
      _end: number;
    };

// Style for piece wrappers. `content-visibility: auto` lets the browser skip
// style/layout/paint for off-screen pieces; `contain-intrinsic-size` reserves
// estimated space so off-screen pieces don't collapse the scroll height.
const pieceWrapperStyle: React.CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 200px",
};

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

  // Cache of the most recent parse result. Used to incrementally reuse
  // pieces from earlier chunks: anything ending strictly before the
  // leftmost in-progress tag opening is byte-immutable in any future
  // content (cleanFullResponse only rewrites within the rewritable tail
  // bounded by the leftmost open dyad-tag), so its piece object can be
  // reused with stable identity. React.memo on MemoMarkdown / MemoCustomTag
  // then short-circuits on referential equality.
  const parseCacheRef = useRef<{
    content: string;
    pieces: ContentPiece[];
    safeBoundary: number;
  } | null>(null);

  // Extract content pieces (markdown and custom tags)
  const contentPieces = useMemo(() => {
    const prev = parseCacheRef.current;
    if (
      prev &&
      prev.safeBoundary > 0 &&
      contentToParse.length >= prev.safeBoundary &&
      contentToParse.startsWith(prev.content.slice(0, prev.safeBoundary))
    ) {
      const reused: ContentPiece[] = [];
      for (const p of prev.pieces) {
        if (p._end <= prev.safeBoundary) reused.push(p);
        else break;
      }
      const reusedEnd = reused.length ? reused[reused.length - 1]._end : 0;
      const tail = contentToParse.slice(reusedEnd);
      const tailResult = parseCustomTags(tail, reusedEnd);
      const merged = reused.concat(tailResult.pieces);
      parseCacheRef.current = {
        content: contentToParse,
        pieces: merged,
        safeBoundary: tailResult.safeBoundary,
      };
      return merged;
    }
    const result = parseCustomTags(contentToParse, 0);
    parseCacheRef.current = {
      content: contentToParse,
      pieces: result.pieces,
      safeBoundary: result.safeBoundary,
    };
    return result.pieces;
  }, [contentToParse]);

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
          <div style={pieceWrapperStyle}>
            {piece.type === "markdown"
              ? piece.content && <MemoMarkdown content={piece.content} />
              : <MemoCustomTag tagInfo={piece.tagInfo} isStreaming={isStreaming} />}
          </div>
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

// Memoized markdown piece. ReactMarkdown + Shiki (CodeHighlight) is the
// dominant per-render cost during streaming; memoizing on `content` keeps
// completed segments from re-parsing/re-highlighting every time the trailing
// piece grows.
const MemoMarkdown = React.memo(function MemoMarkdown({
  content,
}: {
  content: string;
}) {
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
  return true;
}

// Memoized custom-tag piece. parseCustomTags rebuilds tagInfo objects on
// every chunk (new refs), so React.memo's default referential equality
// would never hit. Custom comparator deep-checks the fields that actually
// affect the rendered output. Completed `<dyad-write>` blocks then skip
// Shiki re-highlight when only later pieces change.
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
  (prev, next) => {
    if (prev.isStreaming !== next.isStreaming) return false;
    // Cache hits in DyadMarkdownParser preserve tagInfo identity for
    // unchanged pieces — short-circuit on referential equality so we
    // skip the deep compare entirely when the parse cache reused the
    // piece.
    if (prev.tagInfo === next.tagInfo) return true;
    return tagInfoEqual(prev.tagInfo, next.tagInfo);
  },
);

/**
 * Pre-process content to handle unclosed custom tags
 * Adds closing tags at the end of the content for any unclosed custom tags
 * Assumes the opening tags are complete and valid
 * Returns the processed content and a map of in-progress tags
 */
function preprocessUnclosedTags(content: string): {
  processedContent: string;
  inProgressTags: Map<string, Set<number>>;
} {
  let processedContent = content;
  // Map to track which tags are in progress and their positions
  const inProgressTags = new Map<string, Set<number>>();

  // For each tag type, check if there are unclosed tags
  for (const tagName of DYAD_CUSTOM_TAGS) {
    // Count opening and closing tags
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</${tagName}>`, "g");

    // Track the positions of opening tags
    const openingMatches: RegExpExecArray[] = [];
    let match;

    // Reset regex lastIndex to start from the beginning
    openTagPattern.lastIndex = 0;

    while ((match = openTagPattern.exec(processedContent)) !== null) {
      openingMatches.push({ ...match });
    }

    const openCount = openingMatches.length;
    const closeCount = (processedContent.match(closeTagPattern) || []).length;

    // If we have more opening than closing tags
    const missingCloseTags = openCount - closeCount;
    if (missingCloseTags > 0) {
      // Add the required number of closing tags at the end
      processedContent += Array(missingCloseTags)
        .fill(`</${tagName}>`)
        .join("");

      // Mark the last N tags as in progress where N is the number of missing closing tags
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
 * Parse the content to extract custom tags and markdown sections into a unified array.
 *
 * `baseOffset` shifts the `_start` / `_end` source positions on each emitted
 * piece into a parent coordinate space — used by the incremental cache in
 * `DyadMarkdownParser`, which parses only a tail slice and then merges with
 * pieces reused from the previous parse. Returned `safeBoundary` is the
 * leftmost position (in baseOffset coordinates) of any in-progress tag
 * opening, or `baseOffset + content.length` if there are none. Pieces ending
 * at-or-before this boundary are byte-immutable in any future content and
 * are safe to reuse on the next parse.
 */
function parseCustomTags(
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

  // Find all custom tags
  while ((match = tagPattern.exec(processedContent)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;

    // Add the markdown content before this tag
    if (startIndex > lastIndex) {
      contentPieces.push({
        type: "markdown",
        content: processedContent.substring(lastIndex, startIndex),
        _start: baseOffset + lastIndex,
        _end: baseOffset + startIndex,
      });
    }

    // Parse attributes and unescape values
    const attributes: Record<string, string> = {};
    const attrPattern = /([\w-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
      attributes[attrMatch[1]] = unescapeXmlAttr(attrMatch[2]);
    }

    // Check if this tag was marked as in progress
    const tagInProgressSet = inProgressTags.get(tag);
    const isInProgress = tagInProgressSet?.has(startIndex);

    // Add the tag info with unescaped content
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

  // Add the remaining markdown content
  if (lastIndex < processedContent.length) {
    contentPieces.push({
      type: "markdown",
      content: processedContent.substring(lastIndex),
      _start: baseOffset + lastIndex,
      _end: baseOffset + processedContent.length,
    });
  }

  // Compute leftmost in-progress opening position (in source coordinates).
  let leftmostInProgress = content.length;
  for (const set of inProgressTags.values()) {
    for (const idx of set) {
      if (idx < leftmostInProgress) leftmostInProgress = idx;
    }
  }

  return {
    pieces: contentPieces,
    safeBoundary: baseOffset + leftmostInProgress,
  };
}

function getState({
  isStreaming,
  inProgress,
}: {
  isStreaming?: boolean;
  inProgress?: boolean;
}): CustomTagState {
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
            },
          }}
        >
          {content}
        </DyadGrep>
      );

    case "dyad-add-integration":
      return (
        <DyadAddIntegration
          node={{
            properties: {
              provider: attributes.provider || "",
            },
          }}
        >
          {content}
        </DyadAddIntegration>
      );

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
              include_hidden: attributes.include_hidden || "",
              state: getState({ isStreaming, inProgress }),
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

    case "dyad-supabase-table-schema":
      return (
        <DyadSupabaseTableSchema
          node={{
            properties: {
              table: attributes.table || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </DyadSupabaseTableSchema>
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
              state: getState({ isStreaming, inProgress }),
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
