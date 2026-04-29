import React from "react";
import type { Message } from "@/ipc/types";
import { forwardRef, useState, useCallback, useMemo, useRef } from "react";
import { Virtuoso } from "react-virtuoso";
import ChatMessage from "./ChatMessage";
import { OpenRouterSetupBanner, SetupBanner } from "../SetupBanner";

import { useStreamChat } from "@/hooks/useStreamChat";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { questionnaireSubmittedChatIdsAtom } from "@/atoms/planAtoms";
import { useAtomValue, useSetAtom } from "jotai";
import { CheckCircle2, Loader2, RefreshCw, Undo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVersions } from "@/hooks/useVersions";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { showError, showWarning } from "@/lib/toast";
import { ipc } from "@/ipc/types";
import { chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";
import { PromoMessage } from "./PromoMessage";
import {
  isCancelledResponseContent,
  stripCancelledResponseNotice,
} from "@/shared/chatCancellation";
import {
  parseCustomTags,
  MemoMarkdown,
  MemoCustomTag,
  type ContentPiece,
} from "./DyadMarkdownParser";
import { AssistantMetaFooter } from "./AssistantMetaFooter";
import { StreamingLoadingAnimation } from "./StreamingLoadingAnimation";
import { FixAllErrorsButton } from "./FixAllErrorsButton";

interface MessagesListProps {
  messages: Message[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onAtBottomChange?: (atBottom: boolean) => void;
}

// Memoize ChatMessage at module level to prevent recreation on every render
const MemoizedChatMessage = React.memo(ChatMessage);

// Per-item memoized components. React.memo's shallow compare short-circuits
// re-renders when an item's props are unchanged — critical during streaming,
// where MessagesList re-renders ~12/sec but only the streamed message's tail
// piece actually changes.
const UserItem = React.memo(function UserItem({
  message,
  isLastMessage,
  isCancelledPrompt,
}: {
  message: Message;
  isLastMessage: boolean;
  isCancelledPrompt: boolean;
}) {
  return (
    <div className="px-4 min-h-px">
      <MemoizedChatMessage
        message={message}
        isLastMessage={isLastMessage}
        isCancelledPrompt={isCancelledPrompt}
      />
    </div>
  );
});

const StreamingInitItem = React.memo(function StreamingInitItem() {
  return (
    <div className="px-4 min-h-px">
      <div className="flex justify-start">
        <div className="mt-2 w-full max-w-3xl mx-auto group">
          <div className="rounded-lg p-2">
            <StreamingLoadingAnimation variant="initial" />
          </div>
        </div>
      </div>
    </div>
  );
});

const CancelledEmptyItem = React.memo(function CancelledEmptyItem() {
  return (
    <div className="px-4 min-h-px">
      <div className="flex justify-start">
        <div className="mt-2 w-full max-w-3xl mx-auto group opacity-50">
          <div className="rounded-lg p-2">
            <div className="prose dark:prose-invert max-w-none text-[15px] italic text-muted-foreground">
              Response cancelled before any content was generated.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

const PieceItem = React.memo(function PieceItem({
  piece,
  isFirstItemInMessage,
  isCancelled,
  isStreaming,
  showStreamingAnim,
}: {
  piece: ContentPiece;
  isFirstItemInMessage: boolean;
  isCancelled: boolean;
  isStreaming: boolean;
  showStreamingAnim: boolean;
}) {
  return (
    <div className="px-4 min-h-px">
      <div className="flex justify-start">
        <div
          className={`w-full max-w-3xl mx-auto group ${
            isFirstItemInMessage ? "mt-2" : ""
          } ${isCancelled ? "opacity-50" : ""}`}
        >
          <div
            className="prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-0 max-w-none break-words text-[15px] px-2"
            suppressHydrationWarning
          >
            {piece.type === "markdown"
              ? piece.content && <MemoMarkdown content={piece.content} />
              : <MemoCustomTag
                  tagInfo={piece.tagInfo}
                  isStreaming={isStreaming}
                />}
            {showStreamingAnim && (
              <StreamingLoadingAnimation variant="streaming" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

const FixAllErrorsItem = React.memo(function FixAllErrorsItem({
  chatId,
  errorMessages,
}: {
  chatId: number;
  errorMessages: string[];
}) {
  return (
    <div className="px-4 min-h-px">
      <div className="flex justify-start">
        <div className="w-full max-w-3xl mx-auto px-2">
          <div className="mt-3 w-full flex">
            <FixAllErrorsButton
              errorMessages={errorMessages}
              chatId={chatId}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

const MetaItem = React.memo(function MetaItem({
  message,
  isLastMessage,
  isCancelled,
  hasAssistantText,
  assistantTextContent,
  versions,
}: {
  message: Message;
  isLastMessage: boolean;
  isCancelled: boolean;
  hasAssistantText: boolean;
  assistantTextContent: string;
  versions: { oid: string; message: string }[];
}) {
  return (
    <div className="px-4 min-h-px">
      <AssistantMetaFooter
        message={message}
        isLastMessage={isLastMessage}
        isCancelled={isCancelled}
        hasAssistantText={hasAssistantText}
        assistantTextContent={assistantTextContent}
        versions={versions}
      />
    </div>
  );
});

const computeItemKey = (_index: number, item: { key: string }) => item.key;

interface AssistantPiecesEntry {
  pieces: ContentPiece[];
  safeBoundary: number;
  errorMessages: string[];
  lastErrorPieceIndex: number;
}

/**
 * Parses every assistant message into pieces with a per-message incremental
 * cache. As `messages` updates (streaming chunks), only the streamed message's
 * tail is re-parsed; finalized messages reuse cached pieces with stable refs
 * so MemoMarkdown / MemoCustomTag can short-circuit.
 */
function useAssistantPieces(
  messages: Message[],
): Map<number, AssistantPiecesEntry> {
  const cacheRef = useRef<
    Map<
      number,
      { content: string; pieces: ContentPiece[]; safeBoundary: number }
    >
  >(new Map());

  return useMemo(() => {
    const result = new Map<number, AssistantPiecesEntry>();
    const seen = new Set<number>();

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      seen.add(msg.id);
      const content = stripCancelledResponseNotice(msg.content);
      const prev = cacheRef.current.get(msg.id);
      let pieces: ContentPiece[];
      let safeBoundary: number;

      if (
        prev &&
        prev.safeBoundary > 0 &&
        content.length >= prev.safeBoundary &&
        content.startsWith(prev.content.slice(0, prev.safeBoundary))
      ) {
        const reused: ContentPiece[] = [];
        for (const p of prev.pieces) {
          if (p._end <= prev.safeBoundary) reused.push(p);
          else break;
        }
        const reusedEnd = reused.length ? reused[reused.length - 1]._end : 0;
        const tail = content.slice(reusedEnd);
        const tailResult = parseCustomTags(tail, reusedEnd);
        const merged: ContentPiece[] = reused.slice();
        const tailPieces = tailResult.pieces;
        let tailStart = 0;
        if (
          merged.length > 0 &&
          tailPieces.length > 0 &&
          merged[merged.length - 1].type === "markdown" &&
          tailPieces[0].type === "markdown"
        ) {
          const last = merged[merged.length - 1] as Extract<
            ContentPiece,
            { type: "markdown" }
          >;
          const first = tailPieces[0] as Extract<
            ContentPiece,
            { type: "markdown" }
          >;
          merged[merged.length - 1] = {
            type: "markdown",
            content: last.content + first.content,
            _start: last._start,
            _end: first._end,
          };
          tailStart = 1;
        }
        for (let i = tailStart; i < tailPieces.length; i++) {
          merged.push(tailPieces[i]);
        }
        pieces = merged;
        safeBoundary = tailResult.safeBoundary;
      } else {
        const r = parseCustomTags(content, 0);
        pieces = r.pieces;
        safeBoundary = r.safeBoundary;
      }

      cacheRef.current.set(msg.id, { content, pieces, safeBoundary });

      const errorMessages: string[] = [];
      let lastErrorPieceIndex = -1;
      pieces.forEach((p, i) => {
        if (
          p.type === "custom-tag" &&
          p.tagInfo.tag === "dyad-output" &&
          p.tagInfo.attributes.type === "error"
        ) {
          const m = p.tagInfo.attributes.message;
          if (m?.trim()) {
            errorMessages.push(m.trim());
            lastErrorPieceIndex = i;
          }
        }
      });

      result.set(msg.id, {
        pieces,
        safeBoundary,
        errorMessages,
        lastErrorPieceIndex,
      });
    }

    for (const id of Array.from(cacheRef.current.keys())) {
      if (!seen.has(id)) cacheRef.current.delete(id);
    }

    return result;
  }, [messages]);
}

// Custom tags whose `renderCustomTag` output is intentionally null/empty.
// Skipping these in flatten avoids 0-height Virtuoso items.
const HIDDEN_DYAD_TAGS = new Set(["dyad-chat-summary"]);

type FlatItem =
  | {
      kind: "user";
      key: string;
      message: Message;
      isLastMessage: boolean;
      isCancelledPrompt: boolean;
    }
  | {
      kind: "assistant-streaming-init";
      key: string;
      message: Message;
    }
  | {
      kind: "assistant-cancelled-empty";
      key: string;
      message: Message;
    }
  | {
      kind: "assistant-piece";
      key: string;
      message: Message;
      piece: ContentPiece;
      pieceIndex: number;
      isFirstItemInMessage: boolean;
      showStreamingAnim: boolean;
      isCancelled: boolean;
      isStreaming: boolean;
    }
  | {
      kind: "fix-all-errors";
      key: string;
      message: Message;
      chatId: number;
      errorMessages: string[];
    }
  | {
      kind: "assistant-meta";
      key: string;
      message: Message;
      isLastMessage: boolean;
      isCancelled: boolean;
      hasAssistantText: boolean;
      assistantTextContent: string;
    };

function flattenChatItems(
  messages: Message[],
  piecesByMsgId: Map<number, AssistantPiecesEntry>,
  isStreaming: boolean,
  cancelledPromptIndices: Set<number>,
  selectedChatId: number | null,
): FlatItem[] {
  const items: FlatItem[] = [];
  messages.forEach((message, index) => {
    const isLastMessage = index === messages.length - 1;
    if (message.role === "user") {
      items.push({
        kind: "user",
        key: `u:${message.id}`,
        message,
        isLastMessage,
        isCancelledPrompt: cancelledPromptIndices.has(index),
      });
      return;
    }
    const isCancelled = isCancelledResponseContent(message.content);
    const assistantTextContent = stripCancelledResponseNotice(message.content);
    const hasAssistantText = assistantTextContent.length > 0;
    const data = piecesByMsgId.get(message.id);
    const pieces = data?.pieces ?? [];
    const isMessageStreaming = isStreaming && isLastMessage;

    if (!hasAssistantText && isMessageStreaming) {
      items.push({
        kind: "assistant-streaming-init",
        key: `aini:${message.id}`,
        message,
      });
    } else if (!hasAssistantText && isCancelled) {
      items.push({
        kind: "assistant-cancelled-empty",
        key: `acem:${message.id}`,
        message,
      });
    } else {
      let firstEmitted = false;
      pieces.forEach((piece, pieceIndex) => {
        if (piece.type === "markdown" && !piece.content) return;
        if (
          piece.type === "custom-tag" &&
          HIDDEN_DYAD_TAGS.has(piece.tagInfo.tag)
        )
          return;
        const isLastPiece = pieceIndex === pieces.length - 1;
        items.push({
          kind: "assistant-piece",
          key: `ap:${message.id}:${pieceIndex}`,
          message,
          piece,
          pieceIndex,
          isFirstItemInMessage: !firstEmitted,
          showStreamingAnim: isLastPiece && isMessageStreaming,
          isCancelled,
          isStreaming: isMessageStreaming,
        });
        firstEmitted = true;
        if (
          data &&
          pieceIndex === data.lastErrorPieceIndex &&
          data.errorMessages.length > 1 &&
          !isMessageStreaming &&
          selectedChatId != null
        ) {
          items.push({
            kind: "fix-all-errors",
            key: `fxe:${message.id}`,
            message,
            chatId: selectedChatId,
            errorMessages: data.errorMessages,
          });
        }
      });
    }

    items.push({
      kind: "assistant-meta",
      key: `am:${message.id}`,
      message,
      isLastMessage,
      isCancelled,
      hasAssistantText,
      assistantTextContent,
    });
  });
  return items;
}

// Context type for Virtuoso
interface FooterContext {
  messages: Message[];
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  isStreaming: boolean;
  isUndoLoading: boolean;
  isRetryLoading: boolean;
  setIsUndoLoading: (loading: boolean) => void;
  setIsRetryLoading: (loading: boolean) => void;
  versions: ReturnType<typeof useVersions>["versions"];
  revertVersion: ReturnType<typeof useVersions>["revertVersion"];
  streamMessage: ReturnType<typeof useStreamChat>["streamMessage"];
  selectedChatId: number | null;
  appId: number | null;
  setMessagesById: ReturnType<typeof useSetAtom<typeof chatMessagesByIdAtom>>;
  settings: ReturnType<typeof useSettings>["settings"];
  userBudget: ReturnType<typeof useUserBudgetInfo>["userBudget"];
  renderSetupBanner: () => React.ReactNode;
}

// Footer component for Virtuoso - receives context via props
function FooterComponent({ context }: { context?: FooterContext }) {
  const submittedChatIds = useAtomValue(questionnaireSubmittedChatIdsAtom);
  if (!context) return null;

  const {
    messages,
    messagesEndRef,
    isStreaming,
    isUndoLoading,
    isRetryLoading,
    setIsUndoLoading,
    setIsRetryLoading,
    versions,
    revertVersion,
    streamMessage,
    selectedChatId,
    appId,
    setMessagesById,
    settings,
    userBudget,
    renderSetupBanner,
  } = context;

  const questionnaireState =
    selectedChatId != null ? submittedChatIds.get(selectedChatId) : undefined;

  return (
    <>
      {!isStreaming && (
        <div className="flex max-w-3xl mx-auto gap-2">
          {!!messages.length &&
            messages[messages.length - 1].role === "assistant" && (
              <Button
                variant="outline"
                size="sm"
                disabled={isUndoLoading}
                onClick={async () => {
                  if (!selectedChatId || !appId) {
                    console.error("No chat selected or app ID not available");
                    return;
                  }

                  setIsUndoLoading(true);
                  try {
                    const currentMessage = messages[messages.length - 1];
                    // The user message that triggered this assistant response
                    const userMessage = messages[messages.length - 2];
                    if (currentMessage?.sourceCommitHash) {
                      console.debug(
                        "Reverting to source commit hash",
                        currentMessage.sourceCommitHash,
                      );
                      await revertVersion({
                        versionId: currentMessage.sourceCommitHash,
                        currentChatMessageId: userMessage
                          ? {
                              chatId: selectedChatId,
                              messageId: userMessage.id,
                            }
                          : undefined,
                      });
                      const chat = await ipc.chat.getChat(selectedChatId);
                      setMessagesById((prev) => {
                        const next = new Map(prev);
                        next.set(selectedChatId, chat.messages);
                        return next;
                      });
                    } else {
                      showWarning(
                        "No source commit hash found for message. Need to manually undo code changes",
                      );
                    }
                  } catch (error) {
                    console.error("Error during undo operation:", error);
                    showError("Failed to undo changes");
                  } finally {
                    setIsUndoLoading(false);
                  }
                }}
              >
                {isUndoLoading ? (
                  <Loader2 size={16} className="mr-1 animate-spin" />
                ) : (
                  <Undo size={16} />
                )}
                Undo
              </Button>
            )}
          {!!messages.length && (
            <Button
              variant="outline"
              size="sm"
              disabled={isRetryLoading}
              onClick={async () => {
                if (!selectedChatId) {
                  console.error("No chat selected");
                  return;
                }

                setIsRetryLoading(true);
                try {
                  // The last message is usually an assistant, but it might not be.
                  const lastVersion = versions[0];
                  const lastMessage = messages[messages.length - 1];
                  let shouldRedo = true;
                  if (
                    lastVersion.oid === lastMessage.commitHash &&
                    lastMessage.role === "assistant"
                  ) {
                    const previousAssistantMessage =
                      messages[messages.length - 3];
                    if (
                      previousAssistantMessage?.role === "assistant" &&
                      previousAssistantMessage?.commitHash
                    ) {
                      console.debug("Reverting to previous assistant version");
                      await revertVersion({
                        versionId: previousAssistantMessage.commitHash,
                      });
                      shouldRedo = false;
                    } else {
                      const chat = await ipc.chat.getChat(selectedChatId);
                      if (chat.initialCommitHash) {
                        console.debug(
                          "Reverting to initial commit hash",
                          chat.initialCommitHash,
                        );
                        await revertVersion({
                          versionId: chat.initialCommitHash,
                        });
                      } else {
                        showWarning(
                          "No initial commit hash found for chat. Need to manually undo code changes",
                        );
                      }
                    }
                  }

                  // Find the last user message
                  const lastUserMessage = [...messages]
                    .reverse()
                    .find((message) => message.role === "user");
                  if (!lastUserMessage) {
                    console.error("No user message found");
                    return;
                  }
                  // Need to do a redo, if we didn't delete the message from a revert.
                  const redo = shouldRedo;
                  console.debug("Streaming message with redo", redo);

                  streamMessage({
                    prompt: lastUserMessage.content,
                    chatId: selectedChatId,
                    redo,
                  });
                } catch (error) {
                  console.error("Error during retry operation:", error);
                  showError("Failed to retry message");
                } finally {
                  setIsRetryLoading(false);
                }
              }}
            >
              {isRetryLoading ? (
                <Loader2 size={16} className="mr-1 animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              Retry
            </Button>
          )}
        </div>
      )}

      {questionnaireState && (
        <div
          className={`flex justify-start px-4 duration-300 ${questionnaireState === "fading" ? "animate-out fade-out-0 slide-out-to-bottom-2" : "animate-in fade-in-0 slide-in-from-bottom-2"}`}
        >
          <div className="max-w-3xl w-full mx-auto">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground py-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Answers submitted
            </div>
          </div>
        </div>
      )}
      {isStreaming &&
        !settings?.enableDyadPro &&
        !userBudget &&
        messages.length > 0 && (
          <PromoMessage
            seed={messages.length * (appId ?? 1) * (selectedChatId ?? 1)}
          />
        )}
      <div ref={messagesEndRef} />
      {renderSetupBanner()}
    </>
  );
}

export const MessagesList = forwardRef<HTMLDivElement, MessagesListProps>(
  function MessagesList({ messages, messagesEndRef, onAtBottomChange }, ref) {
    const appId = useAtomValue(selectedAppIdAtom);
    const { versions, revertVersion } = useVersions(appId);
    const { streamMessage, isStreaming } = useStreamChat();
    const { isAnyProviderSetup, isProviderSetup } = useLanguageModelProviders();
    const { settings } = useSettings();
    const setMessagesById = useSetAtom(chatMessagesByIdAtom);
    const [isUndoLoading, setIsUndoLoading] = useState(false);
    const [isRetryLoading, setIsRetryLoading] = useState(false);
    const selectedChatId = useAtomValue(selectedChatIdAtom);
    const { userBudget } = useUserBudgetInfo();

    // Virtualization only renders visible DOM elements, which creates issues for E2E tests:
    // 1. Off-screen logs don't exist in the DOM and can't be queried by test selectors
    // 2. Tests would need complex scrolling logic to bring elements into view before interaction
    // 3. Race conditions and timing issues occur when waiting for virtualized elements to render after scrolling
    const isTestMode = settings?.isTestMode;

    // Wrap state setters in useCallback to stabilize references
    const handleSetIsUndoLoading = useCallback((loading: boolean) => {
      setIsUndoLoading(loading);
    }, []);

    const handleSetIsRetryLoading = useCallback((loading: boolean) => {
      setIsRetryLoading(loading);
    }, []);

    // Stabilize renderSetupBanner with proper dependencies
    const renderSetupBanner = useCallback(() => {
      const selectedModel = settings?.selectedModel;
      if (
        selectedModel?.name === "free" &&
        selectedModel?.provider === "auto" &&
        !isProviderSetup("openrouter")
      ) {
        return <OpenRouterSetupBanner className="w-full" />;
      }
      if (!isAnyProviderSetup()) {
        return <SetupBanner />;
      }
      return null;
    }, [
      settings?.selectedModel?.name,
      settings?.selectedModel?.provider,
      isProviderSetup,
      isAnyProviderSetup,
    ]);

    // Precompute which indices are cancelled prompts so the callback
    // can depend on this set instead of the full messages array reference.
    const cancelledPromptIndices = useMemo(() => {
      const indices = new Set<number>();
      for (let i = 0; i < messages.length - 1; i++) {
        if (
          messages[i].role === "user" &&
          isCancelledResponseContent(messages[i + 1].content)
        ) {
          indices.add(i);
        }
      }
      return indices;
    }, [messages]);

    const piecesByMsgId = useAssistantPieces(messages);
    const items = useMemo(
      () =>
        flattenChatItems(
          messages,
          piecesByMsgId,
          isStreaming,
          cancelledPromptIndices,
          selectedChatId,
        ),
      [
        messages,
        piecesByMsgId,
        isStreaming,
        cancelledPromptIndices,
        selectedChatId,
      ],
    );

    // Memoized item renderer for virtualized list. Each item kind is its own
    // React.memo component so unchanged items short-circuit on re-render.
    const itemContent = useCallback(
      (_index: number, item: FlatItem) => {
        switch (item.kind) {
          case "user":
            return (
              <UserItem
                message={item.message}
                isLastMessage={item.isLastMessage}
                isCancelledPrompt={item.isCancelledPrompt}
              />
            );
          case "assistant-streaming-init":
            return <StreamingInitItem />;
          case "assistant-cancelled-empty":
            return <CancelledEmptyItem />;
          case "assistant-piece":
            return (
              <PieceItem
                piece={item.piece}
                isFirstItemInMessage={item.isFirstItemInMessage}
                isCancelled={item.isCancelled}
                isStreaming={item.isStreaming}
                showStreamingAnim={item.showStreamingAnim}
              />
            );
          case "fix-all-errors":
            return (
              <FixAllErrorsItem
                chatId={item.chatId}
                errorMessages={item.errorMessages}
              />
            );
          case "assistant-meta":
            return (
              <MetaItem
                message={item.message}
                isLastMessage={item.isLastMessage}
                isCancelled={item.isCancelled}
                hasAssistantText={item.hasAssistantText}
                assistantTextContent={item.assistantTextContent}
                versions={versions}
              />
            );
        }
      },
      [versions],
    );

    // Create context object for Footer component with stable references
    const footerContext = useMemo<FooterContext>(
      () => ({
        messages,
        messagesEndRef,
        isStreaming,
        isUndoLoading,
        isRetryLoading,
        setIsUndoLoading: handleSetIsUndoLoading,
        setIsRetryLoading: handleSetIsRetryLoading,
        versions,
        revertVersion,
        streamMessage,
        selectedChatId,
        appId,
        setMessagesById,
        settings,
        userBudget,
        renderSetupBanner,
      }),
      [
        messages,
        messagesEndRef,
        isStreaming,
        isUndoLoading,
        isRetryLoading,
        handleSetIsUndoLoading,
        handleSetIsRetryLoading,
        versions,
        revertVersion,
        streamMessage,
        selectedChatId,
        appId,
        setMessagesById,
        settings,
        userBudget,
        renderSetupBanner,
      ],
    );

    // Render empty state or setup banner
    if (messages.length === 0) {
      const setupBanner = renderSetupBanner();
      if (setupBanner) {
        return (
          <div
            className="absolute inset-0 overflow-y-auto p-4 pb-0 pr-0"
            ref={ref}
            data-testid="messages-list"
          >
            {setupBanner}
          </div>
        );
      }
      return (
        <div
          className="absolute inset-0 overflow-y-auto p-4 pb-0 pr-0"
          ref={ref}
          data-testid="messages-list"
        >
          <div className="flex flex-col items-center justify-center h-full max-w-2xl mx-auto">
            <div className="flex flex-1 items-center justify-center text-gray-500">
              No messages yet
            </div>
          </div>
        </div>
      );
    }

    // In test mode, render all messages without virtualization
    // so E2E tests can query all messages in the DOM
    if (isTestMode) {
      return (
        <div
          className="absolute inset-0 p-4 pb-0 pr-0 overflow-y-auto"
          ref={ref}
          data-testid="messages-list"
        >
          {messages.map((message, index) => {
            const isLastMessage = index === messages.length - 1;
            return (
              <div className="px-4" key={message.id}>
                <ChatMessage
                  message={message}
                  isLastMessage={isLastMessage}
                  isCancelledPrompt={cancelledPromptIndices.has(index)}
                />
              </div>
            );
          })}
          <FooterComponent context={footerContext} />
        </div>
      );
    }

    return (
      <div
        className="absolute inset-0 overflow-y-auto p-4 pb-0 mb-2 pr-0"
        ref={ref}
        data-testid="messages-list"
      >
        <Virtuoso
          data={items}
          increaseViewportBy={{ top: 3000, bottom: 2000 }}
          initialTopMostItemIndex={items.length - 1}
          itemContent={itemContent}
          computeItemKey={computeItemKey}
          components={{ Footer: FooterComponent }}
          context={footerContext}
          atBottomThreshold={80}
          atBottomStateChange={onAtBottomChange}
          followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
        />
      </div>
    );
  },
);
