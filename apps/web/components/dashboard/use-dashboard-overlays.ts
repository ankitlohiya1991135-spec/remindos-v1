"use client";

/**
 * use-dashboard-overlays.ts
 *
 * Manages all overlay open/close state, share system state/functions,
 * walkthrough logic, and related window-event effects.
 *
 * Extracted from dashboard-workspace.tsx to keep that file under 1500 lines.
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
import { useSearchParams } from "next/navigation";
import type { ReminderItem } from "@repo/reminder";
import type { TaskRow } from "./task-panels";
import {
  WALKTHROUGH_STEPS,
  WALKTHROUGH_RELEASE_AT,
  walkthroughStorageKey,
  directoryDisplayName,
} from "./dashboard-utils";
import type {
  ReminderListTab,
  DashboardOverlay,
  DashboardOverlayState,
  DirectoryUser,
  ShareInboxRow,
  TaskActionWarning,
} from "./dashboard-types";

// Re-export directoryDisplayName so consumers don't need to re-import from utils
export { directoryDisplayName };

export interface UseDashboardOverlaysParams {
  userId: string;
  user: { createdAt?: Date | null } | null | undefined;
  refreshTasks: () => Promise<void>;
  resetTaskFormRef: MutableRefObject<() => void>;
  tasksGrouped: { missed: TaskRow[]; pending: TaskRow[]; done: TaskRow[] };
  showShareToast: (msg: string) => void;
  refreshReminders: () => Promise<void>;
  runBriefingStream: () => void;
  handleClearChat: () => void;
  handleExportChat: () => void;
}

export function useDashboardOverlays({
  userId,
  user,
  refreshTasks,
  resetTaskFormRef,
  tasksGrouped,
  showShareToast,
  refreshReminders,
  runBriefingStream,
  handleClearChat,
  handleExportChat,
}: UseDashboardOverlaysParams) {
  const searchParams = useSearchParams();

  // ─── Overlay open/close state ─────────────────────────────────────────────
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isListOpen, setIsListOpen] = useState(false);
  const [isSnapshotOpen, setIsSnapshotOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [isTasksOpen, setIsTasksOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);

  // ─── Overlay-specific state ───────────────────────────────────────────────
  const [editingReminder, setEditingReminder] = useState<ReminderItem | null>(null);
  const [reminderListInitialTab, setReminderListInitialTab] = useState<ReminderListTab>("all");
  const [reminderInitialLinkedTaskId, setReminderInitialLinkedTaskId] = useState("");
  const [taskMode, setTaskMode] = useState<"browse" | "create">("browse");
  const [taskTab, setTaskTab] = useState<"missed" | "pending" | "done" | "all">("pending");
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
  const [taskActionWarning, setTaskActionWarning] = useState<TaskActionWarning | null>(null);

  // ─── Walkthrough state ────────────────────────────────────────────────────
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [walkthroughStepIndex, setWalkthroughStepIndex] = useState(0);
  const walkthroughLoadingRef = useRef(false);

  // ─── Share system state ───────────────────────────────────────────────────
  const [shareReminderIds, setShareReminderIds] = useState<string[]>([]);
  const [directoryUsers, setDirectoryUsers] = useState<DirectoryUser[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [selectedShareUserIds, setSelectedShareUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [shareSending, setShareSending] = useState(false);
  const [shareInbox, setShareInbox] = useState<ShareInboxRow[]>([]);
  const shareBatchUrlHandledRef = useRef<string | null>(null);

  // ─── Derived ──────────────────────────────────────────────────────────────
  const isAnyOverlayOpen =
    isSnapshotOpen ||
    isCreateOpen ||
    isListOpen ||
    isShareOpen ||
    isTasksOpen ||
    isImportOpen ||
    isBatchOpen;

  // ─── Body scroll lock ─────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!isAnyOverlayOpen) return;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [isAnyOverlayOpen]);

  // ─── Core overlay helpers ─────────────────────────────────────────────────
  const closeAllDashboardOverlays = useCallback(() => {
    setIsShareOpen(false);
    setIsBatchOpen(false);
    setIsImportOpen(false);
    setIsTasksOpen(false);
    setTaskMode("browse");
    setTaskActionWarning(null);
    setIsCreateOpen(false);
    setIsListOpen(false);
    setIsSnapshotOpen(false);
  }, []);

  const openCreateModal = useCallback((opts?: { linkedTaskId?: string }) => {
    setEditingReminder(null);
    setReminderInitialLinkedTaskId(opts?.linkedTaskId ?? "");
    setIsCreateOpen(true);
  }, []);

  const openTasksPanel = useCallback(
    (
      mode: "create" | "browse" = "browse",
      preserveState = false,
      initialTab?: "missed" | "pending" | "done" | "all",
    ) => {
      if (!preserveState) {
        resetTaskFormRef.current();
      }
      void refreshTasks();
      setTaskMode(mode);
      if (mode === "create") {
        setTaskTab("pending");
      } else {
        setTaskTab(
          initialTab ??
            (tasksGrouped.missed.length > 0
              ? "missed"
              : tasksGrouped.pending.length > 0
                ? "pending"
                : "done"),
        );
      }
      setIsTasksOpen(true);
    },
    [refreshTasks, resetTaskFormRef, tasksGrouped],
  );

  // ─── History-state helpers ────────────────────────────────────────────────
  const readDashboardOverlayFromHistory =
    useCallback((): DashboardOverlayState | null => {
      if (typeof window === "undefined") return null;
      const raw = (
        window.history.state as {
          dashboardOverlay?: DashboardOverlayState;
        } | null
      )?.dashboardOverlay;
      return raw?.overlay ? raw : null;
    }, []);

  const pushDashboardOverlay = useCallback(
    (state: DashboardOverlayState) => {
      if (typeof window === "undefined") return;
      const hasExistingOverlay = Boolean(
        (
          window.history.state as {
            dashboardOverlay?: DashboardOverlayState;
          } | null
        )?.dashboardOverlay?.overlay,
      );
      const nextState = {
        ...(window.history.state &&
        typeof window.history.state === "object"
          ? window.history.state
          : {}),
        dashboardOverlay: state,
      };
      if (hasExistingOverlay) {
        window.history.replaceState(nextState, "", window.location.href);
      } else {
        window.history.pushState(nextState, "", window.location.href);
      }
    },
    [],
  );

  const dismissDashboardOverlay = useCallback(
    (overlay: DashboardOverlay, fallback: () => void) => {
      const current = readDashboardOverlayFromHistory();
      if (
        current?.overlay === overlay &&
        typeof window !== "undefined"
      ) {
        window.history.back();
        fallback();
        return;
      }
      fallback();
    },
    [readDashboardOverlayFromHistory],
  );

  // ─── Show/close overlay callbacks ────────────────────────────────────────
  const showSnapshotOverlay = useCallback(
    (pushHistory = true) => {
      closeAllDashboardOverlays();
      setIsSnapshotOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "snapshot" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const showReminderListOverlay = useCallback(
    (pushHistory = true, tab: ReminderListTab = "all") => {
      closeAllDashboardOverlays();
      setReminderListInitialTab(tab);
      setIsListOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "reminders", reminderTab: tab });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const showCreateOverlay = useCallback(
    (opts?: { linkedTaskId?: string }, pushHistory = true) => {
      closeAllDashboardOverlays();
      openCreateModal(opts);
      if (pushHistory) pushDashboardOverlay({ overlay: "create" });
    },
    [closeAllDashboardOverlays, openCreateModal, pushDashboardOverlay],
  );

  const showTasksOverlay = useCallback(
    (
      mode: "create" | "browse" = "browse",
      pushHistory = true,
      preserveState = false,
      initialTab?: "missed" | "pending" | "done" | "all",
    ) => {
      closeAllDashboardOverlays();
      openTasksPanel(mode, preserveState, initialTab);
      if (pushHistory)
        pushDashboardOverlay({ overlay: "tasks", taskMode: mode });
    },
    [closeAllDashboardOverlays, openTasksPanel, pushDashboardOverlay],
  );

  const showImportOverlay = useCallback(
    (pushHistory = true) => {
      closeAllDashboardOverlays();
      setIsImportOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "import" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const showBatchOverlay = useCallback(
    (pushHistory = true) => {
      closeAllDashboardOverlays();
      setIsBatchOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "batch" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  // ─── Share system ─────────────────────────────────────────────────────────
  const loadShareInbox = useCallback(async () => {
    try {
      const res = await fetch("/api/reminders/inbox");
      if (!res.ok) return;
      const data = (await res.json()) as { inbox?: ShareInboxRow[] };
      setShareInbox(data.inbox ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadDirectory = useCallback(async () => {
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const res = await fetch("/api/users/directory");
      const data = (await res.json()) as {
        users?: DirectoryUser[];
        error?: string;
      };
      if (!res.ok) {
        setDirectoryError(data.error ?? "Could not load users");
        setDirectoryUsers([]);
        return;
      }
      setDirectoryUsers(data.users ?? []);
    } catch {
      setDirectoryError("Could not load users");
      setDirectoryUsers([]);
    } finally {
      setDirectoryLoading(false);
    }
  }, []);

  const openShareModal = useCallback(
    (ids: string[]) => {
      const unique = [...new Set(ids)].filter(Boolean);
      if (unique.length === 0) return;
      setShareReminderIds(unique);
      setSelectedShareUserIds(new Set());
      setIsShareOpen(true);
      void loadDirectory();
    },
    [loadDirectory],
  );

  const showShareOverlay = useCallback(
    (ids: string[], pushHistory = true) => {
      openShareModal(ids);
      if (pushHistory) {
        pushDashboardOverlay({
          overlay: "share",
          shareReminderIds: [...new Set(ids)].filter(Boolean),
        });
      }
    },
    [openShareModal, pushDashboardOverlay],
  );

  const sendShares = useCallback(async () => {
    if (shareReminderIds.length === 0 || selectedShareUserIds.size === 0)
      return;
    setShareSending(true);
    try {
      const res = await fetch("/api/reminders/share/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reminderIds: shareReminderIds,
          targetUserIds: [...selectedShareUserIds],
        }),
      });
      const data = (await res.json()) as {
        delivered?: number;
        error?: string;
      };
      if (!res.ok) {
        showShareToast(data.error ?? "Could not share");
        return;
      }
      showShareToast(
        data.delivered != null
          ? `Sent · ${data.delivered} notification(s)`
          : "Shared successfully",
      );
      if (
        typeof window !== "undefined" &&
        ((
          window.history.state as {
            dashboardOverlay?: DashboardOverlayState;
          } | null
        )?.dashboardOverlay?.overlay ?? null) === "share"
      ) {
        window.history.back();
      } else {
        setIsShareOpen(false);
      }
      void loadShareInbox();
    } catch {
      showShareToast("Could not share. Try again.");
    } finally {
      setShareSending(false);
    }
  }, [shareReminderIds, selectedShareUserIds, showShareToast, loadShareInbox]);

  const toggleShareUser = useCallback((id: string) => {
    setSelectedShareUserIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const joinShareBatch = useCallback(
    async (batchKey: string) => {
      try {
        const res = await fetch("/api/reminders/share/batch/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchKey }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          showShareToast(data.error ?? "Could not accept");
          return;
        }
        showShareToast("You're in on those reminders.");
        await refreshReminders();
        void loadShareInbox();
      } catch {
        showShareToast("Could not accept");
      }
    },
    [refreshReminders, loadShareInbox, showShareToast],
  );

  const dismissShareBatch = useCallback(
    async (batchKey: string) => {
      try {
        await fetch("/api/reminders/share/batch/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchKey }),
        });
        void loadShareInbox();
      } catch {
        /* ignore */
      }
    },
    [loadShareInbox],
  );

  // isListOpen → load share inbox
  useEffect(() => {
    if (isListOpen) void loadShareInbox();
  }, [isListOpen, loadShareInbox]);

  // shareBatch URL effect
  const shareBatchAction = searchParams?.get("shareBatchAction");
  const batchKeyParam = searchParams?.get("batchKey");
  useEffect(() => {
    const act = shareBatchAction?.trim();
    const key = batchKeyParam?.trim();
    if (!act || !key) return;
    const sig = `${act}:${key}`;
    if (shareBatchUrlHandledRef.current === sig) return;
    shareBatchUrlHandledRef.current = sig;
    let cancelled = false;
    void (async () => {
      try {
        if (act === "accept") {
          const res = await fetch("/api/reminders/share/batch/accept", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batchKey: key }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (!res.ok && !cancelled) {
            showShareToast(data.error ?? "Could not accept");
            shareBatchUrlHandledRef.current = null;
            return;
          }
          if (!cancelled) showShareToast("You're in on those reminders.");
        } else if (act === "deny") {
          await fetch("/api/reminders/share/batch/dismiss", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ batchKey: key }),
          });
        }
        if (!cancelled) {
          await refreshReminders();
          void loadShareInbox();
        }
      } catch {
        shareBatchUrlHandledRef.current = null;
      } finally {
        if (typeof window !== "undefined") {
          window.history.replaceState(
            window.history.state,
            "",
            "/dashboard",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareBatchAction, batchKeyParam, loadShareInbox, showShareToast, refreshReminders]);

  // ─── Close callbacks ──────────────────────────────────────────────────────
  const closeSnapshotOverlay = useCallback(
    () =>
      dismissDashboardOverlay("snapshot", () => setIsSnapshotOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeReminderListOverlay = useCallback(
    () =>
      dismissDashboardOverlay("reminders", () => setIsListOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeCreateOverlay = useCallback(
    () =>
      dismissDashboardOverlay("create", () => setIsCreateOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeTasksOverlay = useCallback(
    () =>
      dismissDashboardOverlay("tasks", () => setIsTasksOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeShareOverlay = useCallback(
    () =>
      dismissDashboardOverlay("share", () => setIsShareOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeImportOverlay = useCallback(
    () =>
      dismissDashboardOverlay("import", () => setIsImportOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeBatchOverlay = useCallback(
    () =>
      dismissDashboardOverlay("batch", () => setIsBatchOpen(false)),
    [dismissDashboardOverlay],
  );

  // ─── Compound open helpers ────────────────────────────────────────────────
  const openEditModal = useCallback(
    (reminder: ReminderItem) => {
      closeAllDashboardOverlays();
      setEditingReminder(reminder);
      setIsCreateOpen(true);
      pushDashboardOverlay({ overlay: "create" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const openAllTasksFromSnapshot = useCallback(() => {
    showTasksOverlay("browse", true, false, "all");
  }, [showTasksOverlay]);

  const openNextTwoHoursFromSnapshot = useCallback(() => {
    showReminderListOverlay(true, "next2hours");
  }, [showReminderListOverlay]);

  const openReminderListFromTasksPanel = useCallback(() => {
    showReminderListOverlay(true, "all");
  }, [showReminderListOverlay]);

  const openLinkedReminderForTask = useCallback(
    (task: TaskRow) => {
      showCreateOverlay({ linkedTaskId: task.id });
    },
    [showCreateOverlay],
  );

  // ─── Walkthrough ──────────────────────────────────────────────────────────
  const markWalkthroughComplete = useCallback(async () => {
    if (!userId || typeof window === "undefined") {
      setWalkthroughOpen(false);
      setWalkthroughStepIndex(0);
      return;
    }
    try {
      await fetch("/api/onboarding/walkthrough", { method: "POST" });
      window.localStorage.setItem(walkthroughStorageKey(userId), "1");
    } catch {
      /* ignore */
    } finally {
      setWalkthroughOpen(false);
      setWalkthroughStepIndex(0);
    }
  }, [userId]);

  const advanceWalkthrough = useCallback(() => {
    setWalkthroughStepIndex((current) => {
      const next = current + 1;
      if (next >= WALKTHROUGH_STEPS.length) {
        void markWalkthroughComplete();
        return current;
      }
      return next;
    });
  }, [markWalkthroughComplete]);

  const closeWalkthrough = useCallback(() => {
    void markWalkthroughComplete();
  }, [markWalkthroughComplete]);

  useEffect(() => {
    if (!userId || !user) return;
    if (typeof window === "undefined") return;
    if (walkthroughLoadingRef.current) return;
    walkthroughLoadingRef.current = true;
    const storageKey = walkthroughStorageKey(userId);
    const createdAt = Number(user.createdAt ?? 0);
    const eligible =
      Number.isFinite(createdAt) && createdAt >= WALKTHROUGH_RELEASE_AT;
    if (!eligible) {
      walkthroughLoadingRef.current = false;
      return;
    }
    if (window.localStorage.getItem(storageKey) === "1") {
      walkthroughLoadingRef.current = false;
      return;
    }
    let active = true;
    const loadWalkthrough = async () => {
      try {
        const response = await fetch("/api/onboarding/walkthrough", {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          show?: boolean;
          completed?: boolean;
          eligible?: boolean;
        };
        if (!active) return;
        if (data.completed || data.show === false) {
          window.localStorage.setItem(storageKey, "1");
          return;
        }
        closeAllDashboardOverlays();
        setWalkthroughStepIndex(0);
        setWalkthroughOpen(true);
      } catch {
        /* ignore */
      } finally {
        if (active) walkthroughLoadingRef.current = false;
      }
    };
    void loadWalkthrough();
    return () => {
      active = false;
    };
  }, [closeAllDashboardOverlays, user, userId]);

  useEffect(() => {
    if (!walkthroughOpen) return;
    closeAllDashboardOverlays();
  }, [walkthroughOpen, walkthroughStepIndex, closeAllDashboardOverlays]);

  // ─── Popstate ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const state =
        (
          event.state as {
            dashboardOverlay?: DashboardOverlayState;
          } | null
        )?.dashboardOverlay ?? null;
      if (!state?.overlay) {
        closeAllDashboardOverlays();
        return;
      }
      switch (state.overlay) {
        case "snapshot":
          showSnapshotOverlay(false);
          break;
        case "reminders":
          showReminderListOverlay(false, state.reminderTab ?? "all");
          break;
        case "create":
          showCreateOverlay(undefined, false);
          break;
        case "tasks":
          showTasksOverlay(state.taskMode ?? "browse", false, true);
          break;
        case "share":
          showShareOverlay(state.shareReminderIds ?? [], false);
          break;
        case "import":
          showImportOverlay(false);
          break;
        case "batch":
          showBatchOverlay(false);
          break;
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [
    closeAllDashboardOverlays,
    showBatchOverlay,
    showCreateOverlay,
    showImportOverlay,
    showReminderListOverlay,
    showShareOverlay,
    showSnapshotOverlay,
    showTasksOverlay,
  ]);

  // ─── Window custom-event listeners ───────────────────────────────────────
  useEffect(() => {
    const openCreate = () => showCreateOverlay(undefined);
    window.addEventListener("dashboard:create-reminder", openCreate);
    return () =>
      window.removeEventListener("dashboard:create-reminder", openCreate);
  }, [showCreateOverlay]);

  useEffect(() => {
    const openR = () => showReminderListOverlay();
    const openT = () => showTasksOverlay("browse", true, false, "all");
    const runB = () => runBriefingStream();
    const clearChat = () => { void handleClearChat(); };
    window.addEventListener("dashboard:open-reminders", openR);
    window.addEventListener("dashboard:open-tasks", openT);
    window.addEventListener("dashboard:run-briefing", runB);
    window.addEventListener("dashboard:clear-chat", clearChat);
    return () => {
      window.removeEventListener("dashboard:open-reminders", openR);
      window.removeEventListener("dashboard:open-tasks", openT);
      window.removeEventListener("dashboard:run-briefing", runB);
      window.removeEventListener("dashboard:clear-chat", clearChat);
    };
  }, [showReminderListOverlay, showTasksOverlay, runBriefingStream, handleClearChat]);

  useEffect(() => {
    const openSnapshot = () => showSnapshotOverlay();
    window.addEventListener("dashboard:snapshot-open", openSnapshot);
    return () =>
      window.removeEventListener("dashboard:snapshot-open", openSnapshot);
  }, [showSnapshotOverlay]);

  useEffect(() => {
    const openCreateTask = () => showTasksOverlay("create", true);
    const openImport = () => showImportOverlay();
    const openBatch = () => showBatchOverlay();
    const exportChat = () => handleExportChat();
    const openNext2h = () => openNextTwoHoursFromSnapshot();
    window.addEventListener("dashboard:create-task", openCreateTask);
    window.addEventListener("dashboard:open-import", openImport);
    window.addEventListener("dashboard:open-batch", openBatch);
    window.addEventListener("dashboard:export-chat", exportChat);
    window.addEventListener("dashboard:open-next-two-hours", openNext2h);
    return () => {
      window.removeEventListener("dashboard:create-task", openCreateTask);
      window.removeEventListener("dashboard:open-import", openImport);
      window.removeEventListener("dashboard:open-batch", openBatch);
      window.removeEventListener("dashboard:export-chat", exportChat);
      window.removeEventListener(
        "dashboard:open-next-two-hours",
        openNext2h,
      );
    };
  }, [
    showTasksOverlay,
    showImportOverlay,
    showBatchOverlay,
    handleExportChat,
    openNextTwoHoursFromSnapshot,
  ]);

  // ─── ?open= URL param ─────────────────────────────────────────────────────
  useEffect(() => {
    const o = searchParams?.get("open");
    if (o !== "reminders" && o !== "tasks" && o !== "create") return;
    if (typeof window !== "undefined") {
      const nextState =
        window.history.state && typeof window.history.state === "object"
          ? { ...window.history.state }
          : {};
      delete (
        nextState as { dashboardOverlay?: DashboardOverlayState }
      ).dashboardOverlay;
      window.history.replaceState(nextState, "", "/dashboard");
    }
    if (o === "reminders") showReminderListOverlay();
    if (o === "tasks") showTasksOverlay("browse", true, false, "all");
    if (o === "create") showCreateOverlay();
  }, [searchParams, showCreateOverlay, showReminderListOverlay, showTasksOverlay]);

  // ─── Return ───────────────────────────────────────────────────────────────
  return {
    // Overlay flags
    isSnapshotOpen,
    isCreateOpen,
    isListOpen,
    isTasksOpen,
    isShareOpen,
    isImportOpen,
    isBatchOpen,
    isAnyOverlayOpen,
    // Overlay-specific state
    editingReminder,
    setEditingReminder,
    reminderListInitialTab,
    reminderInitialLinkedTaskId,
    setReminderInitialLinkedTaskId,
    taskMode,
    setTaskMode,
    taskTab,
    setTaskTab,
    taskSearchQuery,
    setTaskSearchQuery,
    taskActionWarning,
    setTaskActionWarning,
    // Walkthrough
    walkthroughOpen,
    walkthroughStepIndex,
    currentWalkthroughStep:
      WALKTHROUGH_STEPS[walkthroughStepIndex] ?? WALKTHROUGH_STEPS[0]!,
    walkthroughStepCount: WALKTHROUGH_STEPS.length,
    advanceWalkthrough,
    closeWalkthrough,
    // Share system
    shareInbox,
    shareReminderIds,
    directoryUsers,
    directoryLoading,
    directoryError,
    selectedShareUserIds,
    shareSending,
    loadShareInbox,
    openShareModal,
    showShareOverlay,
    sendShares,
    toggleShareUser,
    joinShareBatch,
    dismissShareBatch,
    // Show/close callbacks
    showSnapshotOverlay,
    showReminderListOverlay,
    showCreateOverlay,
    showTasksOverlay,
    showImportOverlay,
    showBatchOverlay,
    closeSnapshotOverlay,
    closeReminderListOverlay,
    closeCreateOverlay,
    closeTasksOverlay,
    closeShareOverlay,
    closeImportOverlay,
    closeBatchOverlay,
    closeAllDashboardOverlays,
    // Compound helpers
    openEditModal,
    openAllTasksFromSnapshot,
    openNextTwoHoursFromSnapshot,
    openReminderListFromTasksPanel,
    openLinkedReminderForTask,
    // Expose internal setters needed by workspace functions
    setIsTasksOpen,
  } as const;
}
