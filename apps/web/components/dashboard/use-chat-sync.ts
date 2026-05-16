"use client";

/**
 * use-chat-sync.ts
 *
 * Owns isHistoryLoaded state and all chat persistence/polling effects:
 *  - loadHistory (initial load from server or localStorage)
 *  - flushChatHistoryToServer (sendBeacon/keepalive persist)
 *  - debounced persist on messages change
 *  - flush on isLoading transition
 *  - flush on visibility/unload events
 *  - remote poll (2.8 s interval + visibility wake-up)
 *
 * Extracted from dashboard-workspace.tsx to reduce line count.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  STARTER_MESSAGE,
  loadChatBackup,
  saveChatBackup,
  clearChatBackup,
  dedupeMessagesById,
  mergeRemoteChat,
} from "./dashboard-utils";
import type { ChatMessage } from "./dashboard-types";

export interface UseChatSyncParams {
  userId: string;
  messages: ChatMessage[];
  isLoading: boolean;
  briefingStreaming: boolean;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  showShareToastRef: MutableRefObject<((msg: string) => void) | null>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  skipRemotePollMergeUntilRef: MutableRefObject<number>;
}

export function useChatSync({
  userId,
  messages,
  isLoading,
  briefingStreaming,
  setMessages,
  showShareToastRef,
  messagesRef,
  skipRemotePollMergeUntilRef,
}: UseChatSyncParams) {
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const isHistoryLoadedRef = useRef(false);
  // Keep ref in sync so flushChatHistoryToServer (a stable callback) reads latest value
  isHistoryLoadedRef.current = isHistoryLoaded;

  // Keep a stable ref to userId for use inside sendBeacon callbacks
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  // Timer ref for debounced persist (owned here — not needed elsewhere)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Persists latest messages; uses sendBeacon/keepalive so a refresh does not drop unsaved debounced writes. */
  const flushChatHistoryToServer = useCallback(() => {
    if (!isHistoryLoadedRef.current) return;
    saveChatBackup(userIdRef.current, messagesRef.current);
    const deduped = dedupeMessagesById(messagesRef.current).filter(
      (m) => !m.meta?.skipPersist,
    );
    if (deduped.length === 0) return;
    const body = JSON.stringify({ messages: deduped });
    const url = "/api/chat/history";
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof Blob !== "undefined" &&
        body.length < 55_000
      ) {
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch {
      /* fall through to fetch */
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      showShareToastRef.current?.("Chat history couldn't be saved — check your connection.");
    });
  }, [messagesRef, showShareToastRef]);

  // ── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    const loadHistory = async () => {
      const fallbackStarter = () =>
        setMessages([{ ...STARTER_MESSAGE, createdAt: new Date().toISOString() }]);

      const syncServer = (list: ChatMessage[]) => {
        const persistable = dedupeMessagesById(list).filter((m) => !m.meta?.skipPersist);
        if (persistable.length === 0) return;
        void fetch("/api/chat/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: persistable }),
        });
      };

      try {
        const response = await fetch("/api/chat/history");
        if (!response.ok) throw new Error("Failed to load chat history");
        const data = (await response.json()) as { messages?: ChatMessage[] };
        const parsed = (data.messages ?? []).filter(
          (item) =>
            item.id && item.content && item.createdAt &&
            (item.role === "user" || item.role === "assistant" || item.role === "system"),
        );
        if (parsed.length > 0) {
          const next = dedupeMessagesById(parsed);
          setMessages(next);
          saveChatBackup(userId, next);
        } else {
          clearChatBackup(userId);
          fallbackStarter();
        }
      } catch {
        const backup = loadChatBackup(userId);
        if (backup && backup.length > 0) {
          const next = dedupeMessagesById(backup);
          setMessages(next);
          syncServer(next);
        } else {
          fallbackStarter();
        }
      } finally {
        setIsHistoryLoaded(true);
      }
    };
    void loadHistory();
  }, [userId, setMessages]);

  // ── Debounced persist on messages change ────────────────────────────────
  useEffect(() => {
    if (!isHistoryLoaded) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      flushChatHistoryToServer();
    }, 350);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [messages, isHistoryLoaded, flushChatHistoryToServer]);

  // ── Flush when loading finishes ─────────────────────────────────────────
  useEffect(() => {
    if (!isHistoryLoaded || isLoading) return;
    flushChatHistoryToServer();
  }, [isLoading, isHistoryLoaded, flushChatHistoryToServer]);

  // ── Flush on tab hide / page unload ────────────────────────────────────
  useEffect(() => {
    const onLeave = () => {
      if (document.visibilityState === "hidden") flushChatHistoryToServer();
    };
    const onUnload = () => flushChatHistoryToServer();
    document.addEventListener("visibilitychange", onLeave);
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onLeave);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [flushChatHistoryToServer]);

  // ── Remote poll (multi-tab sync) ────────────────────────────────────────
  useEffect(() => {
    if (!isHistoryLoaded) return;
    const poll = async () => {
      if (briefingStreaming) return;
      try {
        const response = await fetch("/api/chat/history");
        if (!response.ok) return;
        const data = (await response.json()) as { messages?: ChatMessage[] };
        const remote = (data.messages ?? []).filter(
          (item) =>
            item.id && item.content && item.createdAt &&
            (item.role === "user" || item.role === "assistant" || item.role === "system"),
        );
        setMessages((prev) => {
          if (Date.now() < skipRemotePollMergeUntilRef.current) return prev;
          return mergeRemoteChat(prev, remote);
        });
      } catch {
        /* ignore */
      }
    };
    const id = window.setInterval(poll, 2800);
    const onVis = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isHistoryLoaded, briefingStreaming, setMessages, skipRemotePollMergeUntilRef]);

  return {
    isHistoryLoaded,
    isHistoryLoadedRef,
    flushChatHistoryToServer,
  } as const;
}
