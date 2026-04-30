import React from "react";
import {
  MemoMarkdown,
  MemoCustomTag,
  type CustomTagInfo,
} from "./DyadMarkdownParser";
import type { ContentPiece } from "@/shared/dyadTagParser";

interface InlinePieceProps {
  piece: ContentPiece;
  isStreaming: boolean;
  isCancelled: boolean;
  isFirstItemInMessage: boolean;
}

const FRAME_CLASSES =
  "prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-0 max-w-none break-words text-[15px] px-2";

/**
 * Renders one piece directly from in-renderer parsed content. No IPC fetch.
 * Used during streaming (pieces aren't durable yet) and as a fallback when
 * IPC metadata hasn't loaded yet for a completed message.
 */
export const InlinePiece = React.memo(function InlinePiece({
  piece,
  isStreaming,
  isCancelled,
  isFirstItemInMessage,
}: InlinePieceProps) {
  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-3xl mx-auto group ${
          isFirstItemInMessage ? "mt-2" : ""
        } ${isCancelled ? "opacity-50" : ""}`}
      >
        <div className={FRAME_CLASSES} suppressHydrationWarning>
          {piece.type === "markdown" ? (
            piece.content && <MemoMarkdown content={piece.content} />
          ) : (
            <MemoCustomTag
              tagInfo={piece.tagInfo as CustomTagInfo}
              isStreaming={isStreaming}
            />
          )}
        </div>
      </div>
    </div>
  );
});
