import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle,
  XCircle,
  Clock,
  GitCommit,
  Copy,
  Check,
  Info,
  Bot,
  Ban,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { useAtomValue } from "jotai";
import { isStreamingByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import type { Message } from "@/ipc/types";

interface AssistantMetaFooterVersion {
  oid: string;
  message: string;
}

interface AssistantMetaFooterProps {
  message: Message;
  isLastMessage: boolean;
  isCancelled: boolean;
  hasAssistantText: boolean;
  assistantTextContent: string;
  versions: AssistantMetaFooterVersion[];
}

function formatTimestamp(timestamp: string | Date) {
  const now = new Date();
  const messageTime = new Date(timestamp);
  const diffInHours =
    (now.getTime() - messageTime.getTime()) / (1000 * 60 * 60);
  if (diffInHours < 24) {
    return formatDistanceToNow(messageTime, { addSuffix: true });
  }
  return format(messageTime, "MMM d, yyyy 'at' h:mm a");
}

export function AssistantMetaFooter({
  message,
  isLastMessage,
  isCancelled,
  hasAssistantText,
  assistantTextContent,
  versions,
}: AssistantMetaFooterProps) {
  const chatId = useAtomValue(selectedChatIdAtom);
  const isStreaming =
    useAtomValue(isStreamingByIdAtom).get(chatId!) ?? false;

  const { copyMessageContent, copied } = useCopyToClipboard();
  const handleCopy = async () => {
    await copyMessageContent(assistantTextContent);
  };

  const messageVersion = useMemo(() => {
    if (message.commitHash && versions.length) {
      return (
        versions.find(
          (v) =>
            message.commitHash &&
            v.oid.slice(0, 7) === message.commitHash.slice(0, 7),
        ) || null
      );
    }
    return null;
  }, [message.commitHash, versions]);

  const [copiedRequestId, setCopiedRequestId] = useState(false);
  const copiedRequestIdTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (copiedRequestIdTimeoutRef.current) {
        clearTimeout(copiedRequestIdTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="flex justify-start">
      <div
        className={`w-full max-w-3xl mx-auto group ${isCancelled ? "opacity-50" : ""}`}
      >
        {((hasAssistantText && !isStreaming) || message.approvalState) && (
          <div
            className={`mt-2 flex items-center ${
              hasAssistantText && !isStreaming ? "justify-between" : ""
            } text-xs`}
          >
            {hasAssistantText && !isStreaming && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      data-testid="copy-message-button"
                      onClick={handleCopy}
                      aria-label="Copy"
                      className="flex items-center space-x-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors duration-200 cursor-pointer"
                    />
                  }
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  <span className="hidden sm:inline"></span>
                </TooltipTrigger>
                <TooltipContent>{copied ? "Copied!" : "Copy"}</TooltipContent>
              </Tooltip>
            )}
            <div className="flex flex-wrap gap-2">
              {message.approvalState && (
                <div className="flex items-center space-x-1">
                  {message.approvalState === "approved" ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      <span>Approved</span>
                    </>
                  ) : message.approvalState === "rejected" ? (
                    <>
                      <XCircle className="h-4 w-4 text-red-500" />
                      <span>Rejected</span>
                    </>
                  ) : null}
                </div>
              )}
              {message.model && (
                <div className="flex items-center gap-1 text-gray-500 dark:text-gray-400 w-full sm:w-auto">
                  <Bot className="h-4 w-4 flex-shrink-0" />
                  <span>{message.model}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {message.createdAt && (
          <div className="mt-1 flex flex-wrap items-center justify-start space-x-2 text-xs text-gray-500 dark:text-gray-400 ">
            <div className="flex items-center space-x-1">
              <Clock className="h-3 w-3" />
              <span>{formatTimestamp(message.createdAt)}</span>
            </div>
            {messageVersion && messageVersion.message && (
              <div className="flex items-center space-x-1">
                <GitCommit className="h-3 w-3" />
                <span
                  className="max-w-50 truncate font-medium"
                  title={messageVersion.message}
                >
                  {
                    messageVersion.message
                      .replace(/^\[dyad\]\s*/i, "")
                      .split("\n")[0]
                  }
                </span>
              </div>
            )}
            {message.requestId && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={() => {
                        if (!message.requestId) return;
                        navigator.clipboard
                          .writeText(message.requestId)
                          .then(() => {
                            setCopiedRequestId(true);
                            if (copiedRequestIdTimeoutRef.current) {
                              clearTimeout(
                                copiedRequestIdTimeoutRef.current,
                              );
                            }
                            copiedRequestIdTimeoutRef.current = setTimeout(
                              () => setCopiedRequestId(false),
                              2000,
                            );
                          })
                          .catch(() => {
                            // noop
                          });
                      }}
                      aria-label="Copy Request ID"
                      className="flex items-center space-x-1 px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors duration-200 cursor-pointer"
                    />
                  }
                >
                  {copiedRequestId ? (
                    <Check className="h-3 w-3 text-green-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  <span className="text-xs">
                    {copiedRequestId ? "Copied" : "Request ID"}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {copiedRequestId
                    ? "Copied!"
                    : `Copy Request ID: ${message.requestId.slice(0, 8)}...`}
                </TooltipContent>
              </Tooltip>
            )}
            {isLastMessage && message.totalTokens && (
              <div
                className="flex items-center space-x-1 px-1 py-0.5"
                title={`Max tokens used: ${message.totalTokens.toLocaleString()}`}
              >
                <Info className="h-3 w-3" />
              </div>
            )}
          </div>
        )}
        {isCancelled && (
          <div className="mt-1 flex items-center justify-end gap-1 text-xs text-gray-500 dark:text-gray-400">
            <Ban className="h-3 w-3" />
            <span>Cancelled</span>
          </div>
        )}
      </div>
    </div>
  );
}
