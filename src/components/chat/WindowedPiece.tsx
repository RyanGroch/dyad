import React, { useState } from "react";
import { useMessagePieceContent } from "@/hooks/useMessagePieceContent";
import {
  MemoMarkdown,
  MemoCustomTag,
  type CustomTagInfo,
} from "./DyadMarkdownParser";
import type { MessagePieceMetadata } from "@/ipc/types/chat";
import { ChevronRight, ChevronDown, FileText } from "lucide-react";

interface WindowedPieceProps {
  messageId: number;
  metadata: MessagePieceMetadata;
  isStreaming: boolean;
  isCancelled: boolean;
  isFirstItemInMessage: boolean;
}

// Tag types whose content is large (file bodies, edits) — render a collapsed
// card by default, only fetch full content on expand.
const LAZY_EXPAND_TYPES = new Set([
  "dyad-write",
  "dyad-edit",
  "dyad-search-replace",
  "dyad-rename",
  "dyad-delete",
  "dyad-add-dependency",
  "dyad-execute-sql",
]);

const FRAME_CLASSES =
  "prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-0 max-w-none break-words text-[15px] px-2";

/**
 * Renders one piece. Two modes:
 * - "lazy" (write_file etc.): renders a collapsed header from metadata only.
 *   No content fetched until user clicks expand.
 * - "eager" (markdown, small tags): fetches content on mount, renders inline.
 *
 * Either way, when Virtuoso unmounts the piece (off-screen), all content
 * leaves renderer memory — only metadata stays.
 */
export const WindowedPiece = React.memo(function WindowedPiece({
  messageId,
  metadata,
  isStreaming,
  isCancelled,
  isFirstItemInMessage,
}: WindowedPieceProps) {
  const isLazy = LAZY_EXPAND_TYPES.has(metadata.type);
  const wrapperClasses = `w-full max-w-3xl mx-auto group ${
    isFirstItemInMessage ? "mt-2" : ""
  } ${isCancelled ? "opacity-50" : ""}`;

  if (isLazy) {
    return (
      <div className="flex justify-start">
        <div className={wrapperClasses}>
          <div className={FRAME_CLASSES} suppressHydrationWarning>
            <LazyExpandCard
              messageId={messageId}
              metadata={metadata}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className={wrapperClasses}>
        <div className={FRAME_CLASSES} suppressHydrationWarning>
          <EagerPieceContent
            messageId={messageId}
            metadata={metadata}
            isStreaming={isStreaming}
          />
        </div>
      </div>
    </div>
  );
});

function EagerPieceContent({
  messageId,
  metadata,
  isStreaming,
}: {
  messageId: number;
  metadata: MessagePieceMetadata;
  isStreaming: boolean;
}) {
  const { piece, error, isLoading } = useMessagePieceContent(
    messageId,
    metadata.pieceIndex,
  );
  if (error) {
    return (
      <div className="text-xs text-red-500">
        Failed to load piece: {error}
      </div>
    );
  }
  if (isLoading || !piece) {
    return <div style={{ minHeight: metadata.estHeightPx }} />;
  }
  if (piece.type === "markdown") {
    return <MemoMarkdown content={piece.content} />;
  }
  return (
    <MemoCustomTag
      tagInfo={pieceToTagInfo(piece.type, piece.attributes, piece.content)}
      isStreaming={isStreaming}
    />
  );
}

function LazyExpandCard({
  messageId,
  metadata,
  isStreaming,
}: {
  messageId: number;
  metadata: MessagePieceMetadata;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const path = metadata.attributes?.path ?? "";
  const description = metadata.attributes?.description ?? "";
  const label = describeLazyTag(metadata.type, metadata.attributes);

  return (
    <div className="my-2 rounded-md border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-muted/50 hover:bg-muted transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0" />
        )}
        <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-left truncate">{label}</span>
        {path && (
          <span className="text-xs text-muted-foreground truncate">
            {path}
          </span>
        )}
        {description && (
          <span className="ml-auto text-xs text-muted-foreground truncate hidden sm:inline">
            {description}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2">
          <ExpandedLazyContent
            messageId={messageId}
            metadata={metadata}
            isStreaming={isStreaming}
          />
        </div>
      )}
    </div>
  );
}

function ExpandedLazyContent({
  messageId,
  metadata,
  isStreaming,
}: {
  messageId: number;
  metadata: MessagePieceMetadata;
  isStreaming: boolean;
}) {
  const { piece, error, isLoading } = useMessagePieceContent(
    messageId,
    metadata.pieceIndex,
  );
  if (error) {
    return (
      <div className="text-xs text-red-500">
        Failed to load piece: {error}
      </div>
    );
  }
  if (isLoading || !piece) {
    return (
      <div className="text-xs text-muted-foreground py-2">Loading…</div>
    );
  }
  return (
    <MemoCustomTag
      tagInfo={pieceToTagInfo(piece.type, piece.attributes, piece.content)}
      isStreaming={isStreaming}
    />
  );
}

function describeLazyTag(
  type: string,
  attributes: Record<string, string> | null,
): string {
  switch (type) {
    case "dyad-write":
      return "Write file";
    case "dyad-edit":
      return "Edit file";
    case "dyad-search-replace":
      return "Search & replace";
    case "dyad-rename":
      return `Rename ${attributes?.from ?? ""} → ${attributes?.to ?? ""}`;
    case "dyad-delete":
      return "Delete file";
    case "dyad-add-dependency":
      return `Add dependency ${attributes?.packages ?? ""}`;
    case "dyad-execute-sql":
      return "Execute SQL";
    default:
      return type;
  }
}

function pieceToTagInfo(
  type: string,
  attributes: Record<string, string> | null,
  content: string,
): CustomTagInfo {
  return {
    tag: type,
    attributes: attributes ?? {},
    content,
    fullMatch: "",
    inProgress: false,
  };
}
