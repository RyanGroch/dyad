import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { AnimatePresence, motion, type Transition } from "framer-motion";
import { chatMessagesByIdAtom, isStreamingByIdAtom } from "../atoms/chatAtoms";
import { ipc } from "@/ipc/types";

import { ChatHeader } from "./chat/ChatHeader";
import { ChatMessagesArea } from "./chat/ChatMessagesArea";
import { ChatInput } from "./chat/ChatInput";
import { VersionPane } from "./chat/VersionPane";
import { FreeAgentQuotaBanner } from "./chat/FreeAgentQuotaBanner";
import { NotificationBanner } from "./chat/NotificationBanner";
import { useSettings } from "@/hooks/useSettings";
import { useFreeAgentQuota } from "@/hooks/useFreeAgentQuota";
import { useChatMode } from "@/hooks/useChatMode";
import { isDyadProEnabled } from "@/lib/schemas";
import { terminalOpenByChatIdAtom } from "@/atoms/terminalAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useReducedMotionPref } from "@/hooks/useReducedMotion";
import { useLoadApps } from "@/hooks/useLoadApps";

const TerminalPanel = lazy(() => import("./chat/TerminalPanel"));

interface ChatPanelProps {
  chatId?: number;
  isPreviewOpen: boolean;
  onTogglePreview: () => void;
}

export function ChatPanel({
  chatId,
  isPreviewOpen,
  onTogglePreview,
}: ChatPanelProps) {
  const { t } = useTranslation("chat");
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const [terminalOpenByChatId, setTerminalOpenByChatId] = useAtom(
    terminalOpenByChatIdAtom,
  );
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { apps } = useLoadApps();
  const currentApp = apps.find((app) => app.id === selectedAppId);
  const reducedMotion = useReducedMotionPref();
  const [isVersionPaneOpen, setIsVersionPaneOpen] = useState(false);
  const [terminalFitSignal, setTerminalFitSignal] = useState(0);
  const store = useStore();
  const { settings } = useSettings();
  const { selectedMode, setChatMode } = useChatMode(chatId);
  const { isQuotaExceeded } = useFreeAgentQuota();
  const showFreeAgentQuotaBanner =
    settings &&
    !isDyadProEnabled(settings) &&
    selectedMode === "local-agent" &&
    isQuotaExceeded;

  const isTerminalOpen = chatId
    ? (terminalOpenByChatId.get(chatId) ?? false)
    : false;

  const fetchChatMessages = useCallback(async () => {
    if (!chatId) {
      // no-op when no chat
      return;
    }
    // Skip IPC fetch entirely when streaming: the patch stream carries fresher
    // content than the throttled DB snapshot, and overwriting would corrupt the
    // renderer's base for subsequent patches (offset mismatch). onEnd will do
    // a correct full sync when the stream finishes.
    // Read via store.get so both checks see the current atom value regardless
    // of React batching or commit-to-effect timing.
    if (store.get(isStreamingByIdAtom).get(chatId)) return;
    const chat = await ipc.chat.getChat(chatId);
    // Re-check after the async fetch: streaming may have started while in flight.
    if (store.get(isStreamingByIdAtom).get(chatId)) return;
    setMessagesById((prev) => {
      const next = new Map(prev);
      next.set(chatId, chat.messages);
      return next;
    });
  }, [chatId, setMessagesById, store]); // store is stable; isStreamingById read via store.get at call time

  useEffect(() => {
    fetchChatMessages();
  }, [fetchChatMessages]);

  const closeTerminal = useCallback(() => {
    if (!chatId) return;
    setTerminalOpenByChatId((prev) => {
      const next = new Map(prev);
      next.set(chatId, false);
      return next;
    });
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="toggle-terminal-button"]',
        )
        ?.focus();
    });
  }, [chatId, setTerminalOpenByChatId]);

  const drawerEase: [number, number, number, number] = [0.22, 1, 0.36, 1];
  const chatLayerTransition: Transition = reducedMotion
    ? { duration: 0.12 }
    : { duration: 0.18, ease: drawerEase };
  const terminalLayerTransition: Transition = reducedMotion
    ? { duration: 0.12 }
    : { duration: 0.22, ease: drawerEase };

  const showTerminalDrawer = isTerminalOpen && chatId && !isVersionPaneOpen;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <ChatHeader
        isVersionPaneOpen={isVersionPaneOpen}
        isPreviewOpen={isPreviewOpen}
        onTogglePreview={onTogglePreview}
        onVersionClick={() => setIsVersionPaneOpen(!isVersionPaneOpen)}
      />
      <div className="flex flex-1 overflow-hidden">
        {!isVersionPaneOpen && (
          <div className="relative flex-1 min-w-0 overflow-hidden">
            <AnimatePresence initial={false}>
              {!showTerminalDrawer && (
                <motion.div
                  key="chat"
                  className="absolute inset-0 flex min-h-0 flex-col"
                  initial={
                    reducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }
                  }
                  animate={
                    reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }
                  }
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
                  transition={chatLayerTransition}
                >
                  <ChatMessagesArea chatId={chatId} />
                  {showFreeAgentQuotaBanner && (
                    <FreeAgentQuotaBanner
                      onSwitchToBuildMode={() =>
                        void setChatMode("build").catch(() => {})
                      }
                    />
                  )}
                  <NotificationBanner />
                  <ChatInput chatId={chatId} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
        <VersionPane
          isVisible={isVersionPaneOpen}
          onClose={() => setIsVersionPaneOpen(false)}
        />
      </div>
      <AnimatePresence initial={false}>
        {showTerminalDrawer && (
          <motion.div
            key="terminal"
            data-testid="terminal-drawer"
            className="absolute inset-0 z-20 flex min-h-0 flex-col"
            initial={reducedMotion ? { opacity: 0 } : { y: "100%" }}
            animate={reducedMotion ? { opacity: 1 } : { y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { y: "100%" }}
            transition={terminalLayerTransition}
            onAnimationComplete={() => {
              setTerminalFitSignal((value) => value + 1);
            }}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {t("terminal.loading")}
                </div>
              }
            >
              <TerminalPanel
                appId={selectedAppId}
                chatId={chatId}
                appName={currentApp?.name}
                onExit={closeTerminal}
                fitSignal={terminalFitSignal}
                size="full"
              />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
