import React from "react";
import { useMessagePieceContent } from "@/hooks/useMessagePieceContent";
import {
  MemoMarkdown,
  MemoCustomTag,
  type CustomTagInfo,
} from "./DyadMarkdownParser";
import type { MessagePieceMetadata } from "@/ipc/types/chat";

interface WindowedPieceProps {
  messageId: number;
  metadata: MessagePieceMetadata;
  isStreaming: boolean;
  isCancelled: boolean;
  isFirstItemInMessage: boolean;
}

const FRAME_CLASSES =
  "prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-0 max-w-none break-words text-[15px] px-2";

/**
 * Renders one piece by fetching its full content from main process on mount.
 * When Virtuoso unmounts the piece (off-screen), content leaves renderer
 * memory — only metadata stays.
 *
 * No extra wrapping card here — the tag component (DyadWrite etc.) already
 * provides expand/collapse UI of its own.
 */
export const WindowedPiece = React.memo(function WindowedPiece({
  messageId,
  metadata,
  isStreaming,
  isCancelled,
  isFirstItemInMessage,
}: WindowedPieceProps) {
  const { piece, error, isLoading } = useMessagePieceContent(
    messageId,
    metadata.pieceIndex,
  );

  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-3xl mx-auto group ${
          isFirstItemInMessage ? "mt-2" : ""
        } ${isCancelled ? "opacity-50" : ""}`}
      >
        <div
          className={FRAME_CLASSES}
          suppressHydrationWarning
          style={
            isLoading || error
              ? { minHeight: metadata.estHeightPx }
              : undefined
          }
        >
          {error ? (
            <div className="text-xs text-red-500">
              Failed to load piece: {error}
            </div>
          ) : piece ? (
            piece.type === "markdown" ? (
              <MemoMarkdown content={piece.content} />
            ) : (
              <MemoCustomTag
                tagInfo={pieceToTagInfo(
                  piece.type,
                  piece.attributes,
                  piece.content,
                )}
                isStreaming={isStreaming}
              />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
});

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
