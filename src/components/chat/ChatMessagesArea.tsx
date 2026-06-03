import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
} from "../../atoms/chatAtoms";
import { MessagesList } from "./MessagesList";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ArrowDown } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";

interface ChatMessagesAreaProps {
  chatId?: number;
}

/**
 * Owns the streaming message subscription and scroll behavior. Kept separate
 * from ChatPanel so the per-chunk atom updates re-render only this subtree —
 * ChatPanel and its framer-motion drawer/chat layers stay out of the streaming
 * hot path and don't re-render on every chunk.
 */
export function ChatMessagesArea({ chatId }: ChatMessagesAreaProps) {
  const { t } = useTranslation("chat");
  const { settings } = useSettings();
  const messagesById = useAtomValue(chatMessagesByIdAtom);
  const chatErrorById = useAtomValue(chatErrorByIdAtom);
  const streamCountById = useAtomValue(chatStreamCountByIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  // Tracks whether the user is at the bottom of the scroll container.
  // Uses a ref so followOutput can read it without stale closures,
  // and state for the scroll button UI which needs re-renders.
  const isAtBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // Ref to track previous streaming state for stream-complete scroll
  const prevIsStreamingRef = useRef(false);
  // Track previous chatId to detect chat switches
  const prevChatIdRef = useRef<number | undefined>(undefined);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  // Called by Virtuoso's atBottomStateChange (production) or scroll handler (test mode).
  // Pure position-based: no timeouts, no debounce.
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const handleScrollButtonClick = useCallback(() => {
    // Optimistically mark as at-bottom so followOutput resumes immediately
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  // Scroll to bottom when a new stream starts (user sent a message)
  const streamCount = chatId ? (streamCountById.get(chatId) ?? 0) : 0;
  const messages = chatId ? (messagesById.get(chatId) ?? []) : [];
  const streamError = chatId ? (chatErrorById.get(chatId) ?? null) : null;
  const isStreaming = chatId ? (isStreamingById.get(chatId) ?? false) : false;

  useEffect(() => {
    const isChatSwitch = prevChatIdRef.current !== chatId;
    prevChatIdRef.current = chatId;

    isAtBottomRef.current = true;
    setShowScrollButton(false);

    if (isChatSwitch && messages.length > 0) {
      // When switching chats with existing messages, wait for Virtuoso to render
      // then scroll to ensure we're at the bottom
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom("instant");
        });
      });
    } else if (!isChatSwitch) {
      // For stream count changes (new message sent), wait for Virtuoso to render
      // the placeholder message before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom();
        });
      });
    }
    // Note: if isChatSwitch && messages.length === 0, we don't scroll yet.
    // The messages will be fetched and this effect will re-run with messages.length > 0.
  }, [chatId, streamCount, messages.length, scrollToBottom]);

  // Scroll to bottom when streaming completes to ensure footer content is visible,
  // but only if the user was following (at bottom) during the stream.
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && isAtBottomRef.current) {
      // Double RAF ensures DOM is fully updated with footer content
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom("smooth");
        });
      });
    }
  }, [isStreaming, scrollToBottom]);

  // Keep footer actions (including Retry) visible when stream errors render below.
  useEffect(() => {
    if (!streamError) return;

    const container = messagesContainerRef.current;
    const distanceFromBottom = container
      ? container.scrollHeight - (container.scrollTop + container.clientHeight)
      : 0;
    const isNearBottom = distanceFromBottom <= 220;
    if (!isAtBottomRef.current && !isNearBottom) return;

    let cancelled = false;
    let firstRafId: number | undefined;
    let secondRafId: number | undefined;
    let timeoutId: number | undefined;

    firstRafId = requestAnimationFrame(() => {
      if (cancelled) return;
      secondRafId = requestAnimationFrame(() => {
        if (cancelled) return;
        scrollToBottom("instant");
        timeoutId = window.setTimeout(() => {
          if (!cancelled) {
            scrollToBottom("smooth");
          }
        }, 120);
      });
    });

    return () => {
      cancelled = true;
      if (firstRafId !== undefined) {
        window.cancelAnimationFrame(firstRafId);
      }
      if (secondRafId !== undefined) {
        window.cancelAnimationFrame(secondRafId);
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [streamError, scrollToBottom]);

  // Test mode only: Track scroll position to update isAtBottom state.
  // In production, Virtuoso's atBottomStateChange handles this.
  useEffect(() => {
    if (!settings?.isTestMode) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - (container.scrollTop + container.clientHeight);
      handleAtBottomChange(distanceFromBottom <= 80);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [settings?.isTestMode, handleAtBottomChange]);

  // Test mode: Auto-scroll during streaming when user is at the bottom.
  // In production, Virtuoso's followOutput handles this.
  useEffect(() => {
    if (!settings?.isTestMode) return;

    if (isAtBottomRef.current && isStreaming) {
      requestAnimationFrame(() => {
        scrollToBottom("instant");
      });
    }
  }, [messages, isStreaming, settings?.isTestMode, scrollToBottom]);

  return (
    <div className="flex-1 relative overflow-hidden">
      <MessagesList
        messages={messages}
        messagesEndRef={messagesEndRef}
        ref={messagesContainerRef}
        onAtBottomChange={handleAtBottomChange}
      />

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  onClick={handleScrollButtonClick}
                  size="icon"
                  className="rounded-full shadow-lg hover:shadow-xl transition-all border border-border/50 backdrop-blur-sm bg-background/95 hover:bg-accent"
                  variant="outline"
                />
              }
            >
              <ArrowDown className="h-4 w-4" />
            </TooltipTrigger>
            <TooltipContent>{t("scrollToBottom")}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
