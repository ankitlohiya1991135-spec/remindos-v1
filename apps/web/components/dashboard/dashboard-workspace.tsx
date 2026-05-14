"use client";

import {
  buildBriefingParts,
  buildFollowUpQuestions,
  replaceFollowUpSlot,
  getReminderBucket,
  isAdhocReminder,
  tryGroundedReminderAnswer,
  type BriefingSection,
  type FollowUpQuestion,
  type LifeDomain,
  type TaskItemBrief,
  type ReminderRecurrence,
  type ReminderItem,
} from "@repo/reminder";
import { useUser, useClerk } from "@clerk/nextjs";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { StarRating, priorityStarsLabel } from "./star-rating";
import { StructuredMessage } from "./structured-message";
import {
  TaskFormOverlay,
  TaskListOverlay,
  type TaskRow,
} from "./task-panels";
import { WalkthroughOverlay, type WalkthroughStep } from "./walkthrough-overlay";
import { showDueReminderSystemNotification } from "../../lib/due-notifications-client";
import {
  showCollaborationNotification,
  shouldNotifyForCollaboration,
} from "../../lib/collaboration-notifications";
import { playUiCue } from "../../lib/ui-sound";
import type { ReplyContextPayload } from "../../lib/chat-reply-context";
import {
  isCompactViewport,
  loadDueNotificationPrefs,
  markNotifDueSent,
  readNotifDueSent,
  saveDueNotificationPrefs,
  shouldShowSystemDueNotification,
  type DueNotificationPrefs,
} from "../../lib/reminder-notification-prefs";
import { syncReminderPushSubscription } from "../../lib/push-subscription-client";
import { playDueChime, playPreDuePing, playOverdueNudge } from "../../lib/notification-sounds";
import { NotificationBell } from "../notifications/notification-bell";
import { ChatBubbleShell } from "./chat-bubble-shell";
import { SnapshotOverlay } from "./snapshot-overlay";
import { NotificationPrefsPanel } from "../notifications/notification-prefs-panel";

type ChatRole = "user" | "assistant" | "system";

interface ChatReplyToRef {
  id: string;
  content: string;
  role: ChatRole;
}

interface ChatMessageMeta {
  kind?: "due_reminder" | "briefing" | "opening_summary";
  /** Which slice of the session briefing this bubble is (split messages). */
  briefingSection?: BriefingSection;
  reminderId?: string;
  dueAt?: number;
  title?: string;
  notes?: string;
  /** When true, message is not written to chat history file */
  skipPersist?: boolean;
  replyTo?: ChatReplyToRef;
  editedAt?: string;
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  meta?: ChatMessageMeta;
}

interface AgentAction {
  type:
    | "create_reminder"
    | "list_reminders"
    | "mark_done"
    | "delete_reminder"
    | "reschedule_reminder"
    | "snooze_reminder"
    | "edit_reminder"
    | "bulk_action"
    | "clarify"
    | "pending_confirm"
    | "unknown";
  title?: string;
  dueAt?: string;
  notes?: string;
  linkedTaskId?: string;
  priority?: number;
  domain?: string;
  recurrence?: string;
  pendingType?: "mark_done" | "delete_reminder" | "edit_reminder";
  delayMinutes?: number;
  newTitle?: string;
  newNotes?: string;
  bulkOperation?: "mark_done" | "delete";
  bulkTargetIds?: string[];
  listedIds?: string[];
  suggestedDueAt?: string;
  targetTitle?: string;
  targetId?: string;
  scope?: "today" | "tomorrow" | "missed" | "done" | "pending" | "all" | "later" | "future";
  /** Only on clarify (disambiguation): pending operation type */
  pendingOp?: "mark_done" | "delete" | "reschedule" | "edit" | "snooze";
  /** Only on clarify (disambiguation): IDs of ambiguous reminder candidates */
  candidateIds?: string[];
  /** Only on clarify (reschedule disambiguation): already-parsed new due date ISO */
  pendingDueAt?: string;
  /** Only on clarify (edit disambiguation): which field is being edited */
  pendingField?: "title" | "notes";
  /** Only on clarify (edit disambiguation): the new field value */
  pendingValue?: string;
  /** Only on clarify (snooze disambiguation): snooze delay in minutes */
  pendingDelayMinutes?: number;
}

interface AgentResponse {
  reply: string;
  action: AgentAction;
}
interface PendingCreateDraft {
  step: "title" | "date" | "time" | "task" | "priority";
  title?: string;
  notes?: string;
  dateIso?: string;
  dueAt?: string;
  linkedTaskId?: string;
  priority?: number;
}

interface WorkspaceProps {
  userId: string;
}

type DashboardOverlay =
  | "snapshot"
  | "create"
  | "reminders"
  | "tasks"
  | "share"
  | "import"
  | "batch";

interface DashboardOverlayState {
  overlay: DashboardOverlay;
  taskMode?: "create" | "browse";
  shareReminderIds?: string[];
}

interface DirectoryUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  username: string;
  imageUrl: string;
}

interface ShareInboxRow {
  _id: string;
  reminderId: string;
  token: string;
  fromUserId: string;
  fromDisplayName: string;
  toUserId: string;
  title: string;
  dueAt: number;
  createdAt: number;
  shareBatchId?: string;
}

type TaskWarningAction = "delete" | "complete";

interface TaskActionWarning {
  task: TaskRow;
  action: TaskWarningAction;
  pendingReminderCount: number;
}

export type ReminderListTab =
  | "all"
  | "missed"
  | "today"
  | "tomorrow"
  | "next2hours"
  | "upcoming"
  | "done"
  | "shared"
  | "sent";


function groupShareInboxRows(
  rows: ShareInboxRow[],
): { batchKey: string; rows: ShareInboxRow[] }[] {
  const map = new Map<string, ShareInboxRow[]>();
  for (const row of rows) {
    const key = row.shareBatchId ?? `legacy:${row._id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return [...map.entries()].map(([batchKey, list]) => ({
    batchKey,
    rows: list,
  }));
}

function directoryDisplayName(u: DirectoryUser): string {
  const n = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (n) return n;
  if (u.username) return `@${u.username}`;
  return u.email || "User";
}

const loadingTexts = [
  "Processing your message...",
  "Understanding your reminder intent...",
  "Preparing the best response for you...",
  "Almost there, finalizing your reminder assistant reply...",
];

const STARTER_MESSAGE = {
  id: "starter",
  role: "assistant" as const,
  content:
    "Hi! Ask me anything about your reminders—what's next, times, notes, or compare your day. I can also create or complete them. Example: 'Create reminder tomorrow at 9am for gym'.",
  createdAt: new Date().toISOString(),
  meta: {
    skipPersist: true,
  },
};

function formatSummaryTime(value: string) {
  try {
    return new Date(value).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function formatDisplayDateTime(value: string | number) {
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}

function buildOpeningSummaryMessage(input: {
  reminders: ReminderItem[];
  tasks: TaskItemBrief[];
  firstName?: string | null;
  now?: Date;
}): ChatMessage {
  const now = input.now ?? new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const next2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const overdueToday: ReminderItem[] = [];
  const nextTwoHours: ReminderItem[] = [];
  const upcomingLater: ReminderItem[] = [];

  for (const reminder of input.reminders) {
    if (reminder.status === "done" || reminder.status === "archived") continue;
    const dueMs = new Date(reminder.dueAt).getTime();
    if (!Number.isFinite(dueMs)) continue;

    if (dueMs >= startToday.getTime() && dueMs < now.getTime()) {
      overdueToday.push(reminder);
      continue;
    }
    if (dueMs >= now.getTime() && dueMs < next2h.getTime()) {
      nextTwoHours.push(reminder);
      continue;
    }
    if (dueMs >= next2h.getTime()) {
      upcomingLater.push(reminder);
    }
  }

  overdueToday.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  nextTwoHours.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  upcomingLater.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  const name = input.firstName?.trim();
  const lines = [
    name ? `Good ${now.getHours() < 12 ? "morning" : now.getHours() < 18 ? "afternoon" : "evening"}, ${name}.` : "Here is your reminder overview:",
    "",
    `### 1) Today's overdue reminders (${overdueToday.length})`,
  ];

  if (overdueToday.length === 0) {
    lines.push("- None");
  } else {
    for (const item of overdueToday) {
      lines.push(`- ${formatSummaryTime(item.dueAt)} — **${item.title}**`);
    }
  }

  lines.push("", `### 2) Next 2 hours reminders (${nextTwoHours.length})`);
  if (nextTwoHours.length === 0) {
    lines.push("- None");
  } else {
    for (const item of nextTwoHours) {
      lines.push(`- ${formatSummaryTime(item.dueAt)} — **${item.title}**`);
    }
  }

  lines.push("", `### 3) Remaining upcoming reminders (${upcomingLater.length})`);
  if (upcomingLater.length === 0) {
    lines.push("- None");
  } else {
    for (const item of upcomingLater.slice(0, 12)) {
      lines.push(`- ${new Date(item.dueAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })} ${formatSummaryTime(item.dueAt)} — **${item.title}**`);
    }
  }

  return {
    id: `opening-summary-${Date.now()}`,
    role: "assistant",
    content: lines.join("\n"),
    createdAt: now.toISOString(),
    meta: {
      kind: "opening_summary",
      skipPersist: true,
    },
  };
}

const SHOW_SUGGESTED_QUESTIONS_KEY = "remindos:showSuggestedQuestions";
const DEFAULT_CHAT_REMINDER_TITLE = "Reminder";

function usePersistentReminders(userId: string) {
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setReminders([]);
    setIsLoaded(false);
    const load = async () => {
      try {
        const response = await fetch("/api/reminders");
        if (!response.ok) throw new Error("Failed to load reminders");
        const data = (await response.json()) as {
          reminders?: Array<Record<string, unknown>>;
        };
        const parsed = (data.reminders ?? []).map((item) =>
          fromApiReminder(item),
        );
        setReminders(parsed);
      } catch {
        setReminders([]);
      } finally {
        setIsLoaded(true);
      }
    };
    void load();
  }, [userId]);

  const updateReminders = (
    updater: (prev: ReminderItem[]) => ReminderItem[],
  ) => {
    setReminders((prev) => {
      return updater(prev);
    });
  };

  return [reminders, updateReminders, isLoaded] as const;
}

function dedupeMessagesById(messages: ChatMessage[]) {
  const map = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (!message?.id) continue;
    map.set(message.id, message);
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/** Ensures server-side chat uses the same IANA zone as the browser (fixes UTC vs local due times). */
function clientTimeZonePayload(): { timeZone?: string } {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz ? { timeZone: tz } : {};
  } catch {
    return {};
  }
}

function mergeRemoteChat(
  local: ChatMessage[],
  remote: ChatMessage[],
): ChatMessage[] {
  if (remote.length === 0) return local;
  const localBase = local.filter((m) => m.id !== "starter");
  const remoteMap = new Map(remote.map((m) => [m.id, m]));
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  for (const m of localBase) {
    if (m.meta?.skipPersist) {
      out.push(m);
      seen.add(m.id);
      continue;
    }
    const r = remoteMap.get(m.id);
    out.push(r ?? m);
    seen.add(m.id);
  }
  for (const m of remote) {
    if (!seen.has(m.id)) {
      out.push(m);
      seen.add(m.id);
    }
  }
  return dedupeMessagesById(out);
}

const CHAT_THREAD_BACKUP_PREFIX = "remindos:chatThread:";
const WALKTHROUGH_RELEASE_AT = Date.parse("2026-04-20T00:00:00.000Z");
const WALKTHROUGH_STORAGE_PREFIX = "remindos:walkthrough-completed:";

const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    id: "all-tasks",
    line1: "This is All tasks.",
    line2: "Open it to view, edit, and track all tasks quickly.",
    targetSelectors: [
      '[data-walkthrough="all-tasks-trigger"]',
      '[aria-label="All tasks"]',
    ],
    nextLabel: "Next",
  },
  {
    id: "briefing",
    line1: "This is Briefing.",
    line2: "Tap it for a quick summary of what needs attention now.",
    targetSelectors: [
      '[data-walkthrough="briefing-trigger"]',
      '[aria-label="Run briefing"]',
    ],
    nextLabel: "Next",
  },
  {
    id: "create-reminder",
    line1: "This is Create reminder.",
    line2: "Add a reminder in seconds with date, priority, and notes.",
    targetSelectors: [
      '[data-walkthrough="create-reminder-trigger"]',
      '[data-testid="chat-mobile-create-reminder"]',
      '[aria-label="Create reminder"]',
    ],
    nextLabel: "Next",
  },
  {
    id: "menu",
    line1: "This is your workspace menu.",
    line2: "Use it to open snapshot and other quick actions.",
    targetSelectors: [
      '[data-walkthrough="snapshot-trigger"]',
      '[aria-label="Open workspace menu"]',
    ],
    nextLabel: "Finish",
  },
];

function walkthroughStorageKey(userId: string) {
  return `${WALKTHROUGH_STORAGE_PREFIX}${userId}`;
}

function chatThreadBackupKey(userId: string) {
  return `${CHAT_THREAD_BACKUP_PREFIX}${userId}`;
}

function loadChatBackup(userId: string): ChatMessage[] | null {
  if (typeof localStorage === "undefined" || !userId) return null;
  try {
    const raw = localStorage.getItem(chatThreadBackupKey(userId));
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data) || data.length === 0) return null;
    const out: ChatMessage[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      const id = typeof m.id === "string" ? m.id : null;
      const role = m.role;
      const content = typeof m.content === "string" ? m.content : "";
      const createdAt = typeof m.createdAt === "string" ? m.createdAt : null;
      if (!id || !createdAt) continue;
      if (role !== "user" && role !== "assistant" && role !== "system")
        continue;
      if (!content.trim()) continue;
      out.push({
        id,
        role,
        content,
        createdAt,
        meta: m.meta as ChatMessage["meta"],
      });
    }
    return out.length > 0 ? dedupeMessagesById(out) : null;
  } catch {
    return null;
  }
}

function saveChatBackup(userId: string, messages: ChatMessage[]): void {
  if (typeof localStorage === "undefined" || !userId) return;
  try {
    const persistable = dedupeMessagesById(messages).filter(
      (m) => !m.meta?.skipPersist,
    );
    if (persistable.length === 0) {
      localStorage.removeItem(chatThreadBackupKey(userId));
      return;
    }
    const capped = persistable.slice(-400);
    localStorage.setItem(chatThreadBackupKey(userId), JSON.stringify(capped));
  } catch {
    /* quota or private mode */
  }
}

function clearChatBackup(userId: string): void {
  if (typeof localStorage === "undefined" || !userId) return;
  try {
    localStorage.removeItem(chatThreadBackupKey(userId));
  } catch {
    /* ignore */
  }
}

const LIFE_DOMAINS = new Set<string>([
  "health",
  "finance",
  "career",
  "hobby",
  "fun",
]);

function parseLifeDomain(value: unknown): LifeDomain | undefined {
  return typeof value === "string" && LIFE_DOMAINS.has(value)
    ? (value as LifeDomain)
    : undefined;
}

function fromApiTask(row: Record<string, unknown>): TaskRow {
  const pr = row.priority;
  return {
    id: String(row._id ?? row.id ?? crypto.randomUUID()),
    title: String(row.title ?? ""),
    notes: typeof row.notes === "string" ? row.notes : undefined,
    dueAt:
      row.dueAt != null ? new Date(Number(row.dueAt)).toISOString() : undefined,
    status: row.status === "done" ? "done" : "pending",
    priority: typeof pr === "number" && Number.isFinite(pr) ? pr : undefined,
    domain: parseLifeDomain(row.domain),
  };
}

function taskBucket(task: TaskRow, now: Date): "missed" | "later" | "done" {
  if (task.status === "done") return "done";
  if (task.dueAt && new Date(task.dueAt).getTime() < now.getTime())
    return "missed";
  return "later";
}

function fromApiReminder(item: Record<string, unknown>): ReminderItem {
  const access = item._access === "shared" ? "shared" : "owner";
  const p = item.priority;
  const linked = item.linkedTaskId;
  const ownerUserId =
    access === "shared" && typeof item.userId === "string"
      ? item.userId
      : undefined;
  const shareRecipients = Array.isArray(item._shareRecipients)
    ? (item._shareRecipients as { userId: string; displayName: string }[])
    : undefined;
  const outgoingShared = item._outgoingShared === true;
  return {
    id: String(item._id ?? item.id ?? crypto.randomUUID()),
    title: String(item.title ?? ""),
    dueAt: new Date(Number(item.dueAt ?? Date.now())).toISOString(),
    notes: typeof item.notes === "string" ? item.notes : "",
    recurrence:
      item.recurrence === "daily" ||
      item.recurrence === "weekly" ||
      item.recurrence === "monthly"
        ? item.recurrence
        : "none",
    status:
      item.status === "done" || item.status === "archived"
        ? item.status
        : "pending",
    priority: typeof p === "number" && Number.isFinite(p) ? p : undefined,
    createdAt: new Date(Number(item.createdAt ?? Date.now())).toISOString(),
    updatedAt: new Date(Number(item.updatedAt ?? Date.now())).toISOString(),
    access,
    ownerUserId,
    shareRecipients: access === "owner" ? shareRecipients : undefined,
    outgoingShared: access === "owner" ? outgoingShared : undefined,
    linkedTaskId: typeof linked === "string" ? linked : undefined,
    domain: parseLifeDomain(item.domain),
  };
}

function matchesReminder(
  reminder: ReminderItem,
  targetId?: string,
  targetTitle?: string,
) {
  if (targetId && reminder.id === targetId) return true;
  if (!targetTitle) return false;
  return reminder.title.toLowerCase().includes(targetTitle.toLowerCase());
}

const DUE_SHOWN_KEY = "remindos:dueShown";

function dueMinuteKey(reminder: ReminderItem) {
  const d = new Date(reminder.dueAt);
  return `${reminder.id}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

function isDueThisMinute(dueAtIso: string, now: Date) {
  const d = new Date(dueAtIso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate() &&
    d.getHours() === now.getHours() &&
    d.getMinutes() === now.getMinutes()
  );
}


function isNextTwoHoursReminder(reminder: ReminderItem, now = new Date()) {
  if (reminder.status === "done" || reminder.status === "archived") return false;
  const dueMs = new Date(reminder.dueAt).getTime();
  if (!Number.isFinite(dueMs)) return false;
  const nextTwoHoursMs = now.getTime() + 2 * 60 * 60 * 1000;
  return dueMs >= now.getTime() && dueMs < nextTwoHoursMs;
}

function reminderStateLabel(reminder: ReminderItem, now = new Date()) {
  if (reminder.status === "done" || reminder.status === "archived") return "Done";
  if (getReminderBucket(reminder, now) === "missed") return "Missed";
  return "Upcoming";
}

function readDueShown(): Set<string> {
  if (typeof sessionStorage === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(DUE_SHOWN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function markDueShown(key: string) {
  if (typeof sessionStorage === "undefined") return;
  const next = readDueShown();
  next.add(key);
  sessionStorage.setItem(DUE_SHOWN_KEY, JSON.stringify([...next]));
}

function toReplyContextPayload(
  target: ChatMessage | null | undefined,
): ReplyContextPayload | undefined {
  if (!target?.content?.trim()) return undefined;
  return {
    id: target.id,
    content: target.content,
    role: target.role === "system" ? "system" : target.role,
  };
}

function chatReplyLabel(role: ChatRole): string {
  if (role === "user") return "You";
  if (role === "assistant") return "RemindOS";
  return "Notice";
}

function briefingSectionLabel(section: BriefingSection | undefined): string {
  switch (section) {
    case "greeting":
      return "Briefing";
    case "completed":
      return "Completed";
    case "overdue":
      return "Overdue";
    case "today":
      return "Today";
    case "tomorrow":
      return "Tomorrow";
    case "later":
      return "Coming up";
    case "tasks":
      return "Tasks by priority";
    case "closing":
      return "Next step";
    default:
      return "Session briefing";
  }
}

// ChatBubbleShell is now a standalone component — see ./chat-bubble-shell.tsx

function toDateTimeLocalValue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function currentDateTimeLocalValue(): string {
  return toDateTimeLocalValue(new Date().toISOString());
}

function extractInviteToken(text: string): string | null {
  const trimmed = text.trim();
  const fromUrl = trimmed.match(/[?&]invite=([^&\s#]+)/i);
  if (fromUrl?.[1]) return decodeURIComponent(fromUrl[1]);
  const acceptHex = trimmed.match(/\baccept\s+invite\s+([a-f\d]{16,64})\b/i);
  if (acceptHex?.[1]) return acceptHex[1];
  const plainHex = trimmed.match(/\b([a-f\d]{24,40})\b/i);
  if (plainHex?.[1] && /\b(accept|invite|join)\b/i.test(trimmed))
    return plainHex[1];
  return null;
}

// ─────────────────────────────────────────────────────────────
// ShareOverlay – Screen 11 · Sharing & Collaboration
// ─────────────────────────────────────────────────────────────
function ShareOverlay({
  shareReminderIds,
  reminders,
  directoryUsers,
  directoryLoading,
  directoryError,
  selectedShareUserIds,
  shareSending,
  onToggleUser,
  onSend,
  onClose,
  getDisplayName,
}: {
  shareReminderIds: string[];
  reminders: ReminderItem[];
  directoryUsers: DirectoryUser[];
  directoryLoading: boolean;
  directoryError: string | null;
  selectedShareUserIds: Set<string>;
  shareSending: boolean;
  onToggleUser: (id: string) => void;
  onSend: () => void;
  onClose: () => void;
  getDisplayName: (u: DirectoryUser) => string;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredUsers = searchQuery.trim()
    ? directoryUsers.filter((u) => {
        const q = searchQuery.toLowerCase();
        return (
          getDisplayName(u).toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
        );
      })
    : directoryUsers;

  const selectedCount = selectedShareUserIds.size;

  /* Avatar gradient colors cycling through 5 violet/teal shades */
  const avatarGradients = [
    "linear-gradient(135deg,#7c3aed,#5b21b6)",
    "linear-gradient(135deg,#6366f1,#4338ca)",
    "linear-gradient(135deg,#06b6d4,#0891b2)",
    "linear-gradient(135deg,#8b5cf6,#7c3aed)",
    "linear-gradient(135deg,#0ea5e9,#06b6d4)",
  ];

  return (
    <div
      className="fixed inset-0 z-[55] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        className="flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle bar */}
        <div className="flex shrink-0 justify-center pt-2.5 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-slate-200" />
        </div>

        {/* Header */}
        <div className="shrink-0 px-5 pt-3 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              {/* Share icon circle */}
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100">
                <svg viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>
                </svg>
              </div>
              <div>
                <h3 id="share-dialog-title" className="text-[17px] font-extrabold text-slate-900">
                  Share Reminders
                </h3>
                <p className="text-[12px] text-slate-400">
                  {shareReminderIds.length} reminder{shareReminderIds.length > 1 ? "s" : ""} selected
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>

          {/* Reminder name chips */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {shareReminderIds.map((id) => {
              const title = reminders.find((r) => r.id === id)?.title ?? id;
              return (
                <span
                  key={id}
                  className="rounded-full border border-violet-300 bg-violet-50 px-3 py-1 text-[11px] font-semibold text-violet-700"
                >
                  {title}
                </span>
              );
            })}
          </div>
        </div>

        {/* Search bar */}
        <div className="shrink-0 px-5 pb-3">
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 shrink-0 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search people..."
              className="flex-1 bg-transparent text-[13px] text-slate-700 outline-none placeholder:text-slate-400"
              autoFocus
            />
          </div>
        </div>

        {/* User list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {directoryLoading ? (
            <div className="flex items-center justify-center py-10">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-violet-600 border-t-transparent" />
            </div>
          ) : directoryError ? (
            <p className="px-2 py-4 text-center text-[13px] text-rose-600">{directoryError}</p>
          ) : filteredUsers.length === 0 ? (
            <p className="px-2 py-8 text-center text-[13px] text-slate-400">
              {searchQuery ? "No users match your search." : "No other users found."}
            </p>
          ) : (
            <div className="space-y-1">
              {filteredUsers.map((u, idx) => {
                const selected = selectedShareUserIds.has(u.id);
                const name = getDisplayName(u);
                const initial = name.slice(0, 1).toUpperCase();
                const gradient = avatarGradients[idx % avatarGradients.length]!;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => onToggleUser(u.id)}
                    className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${
                      selected ? "bg-violet-50" : "hover:bg-slate-50"
                    }`}
                  >
                    {/* Avatar */}
                    {u.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={u.imageUrl}
                        alt=""
                        className="h-11 w-11 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
                        style={{ background: gradient }}
                      >
                        {initial}
                      </span>
                    )}

                    {/* Name + email */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-bold text-slate-900">{name}</span>
                      <span className="block truncate text-[12px] text-slate-400">{u.email || "—"}</span>
                    </span>

                    {/* Selection indicator */}
                    {selected ? (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600">
                        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                          <path d="m5 12 4 4 10-10" />
                        </svg>
                      </span>
                    ) : (
                      <span className="h-6 w-6 shrink-0 rounded-full border-2 border-slate-300" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-3 border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="text-[14px] font-semibold text-slate-500"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={shareSending || selectedCount === 0}
            onClick={onSend}
            className="flex-1 rounded-full bg-violet-600 py-3 text-[14px] font-bold text-white shadow-md shadow-violet-500/30 transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {shareSending
              ? "Sending…"
              : selectedCount === 0
                ? "Select people"
                : `Send to ${selectedCount} person${selectedCount > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ReminderCard – extracted so the list JSX stays readable
// ─────────────────────────────────────────────────────────────
interface ReminderCardProps {
  reminder: ReminderItem;
  tab: string;
  selectionMode: boolean;
  selected: boolean;
  taskTitleById: Record<string, string | undefined>;
  onSelect: (id: string) => void;
  onLongPressStart: (id: string) => void;
  onLongPressEnd: () => void;
  onMarkDone: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onShare: () => void;
  onSnooze: () => void;
}

function ReminderCard({
  reminder,
  tab,
  selectionMode,
  selected,
  taskTitleById,
  onSelect,
  onLongPressStart,
  onLongPressEnd,
  onMarkDone,
  onDelete,
  onEdit,
  onShare,
  onSnooze,
}: ReminderCardProps) {
  const isDone = reminder.status === "done" || reminder.status === "archived";
  const linkedTaskTitle = reminder.linkedTaskId ? taskTitleById[reminder.linkedTaskId] : undefined;
  const isAdhoc = isAdhocReminder(reminder) || !linkedTaskTitle;

  const circleColor =
    tab === "done"      ? "#10b981" :
    tab === "missed"    ? "#f43f5e" :
    tab === "today"     ? "#f59e0b" :
    tab === "tomorrow"  ? "#7c3aed" :
    tab === "shared" || tab === "sent" ? "#06b6d4" :
    "#94a3b8";

  // Compute overdue label for missed tab
  let overdueLabel = "";
  if (tab === "missed") {
    const diffMs = Date.now() - new Date(reminder.dueAt).getTime();
    const diffH = Math.floor(diffMs / (1000 * 60 * 60));
    const diffM = Math.floor(diffMs / (1000 * 60));
    overdueLabel = diffH > 0 ? `${diffH}h overdue` : diffM > 0 ? `${diffM}m overdue` : "Just missed";
  }

  // Friendly time label
  let timeLabel = "";
  try {
    timeLabel = new Date(reminder.dueAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch { /* ignore */ }

  const domainColors: Record<string, string> = {
    health:  "#10b981",
    finance: "#06b6d4",
    career:  "#6366f1",
    hobby:   "#7c3aed",
    fun:     "#f59e0b",
  };
  const domainColor = reminder.domain ? (domainColors[reminder.domain] ?? "#94a3b8") : "#94a3b8";

  return (
    <article
      data-testid="reminder-card"
      data-reminder-id={reminder.id}
      className={`mb-2 flex gap-3 rounded-2xl border bg-white px-3.5 py-3 shadow-sm transition ${
        selected ? "border-violet-400 ring-2 ring-violet-400/25" : "border-slate-100"
      }`}
      onTouchStart={() => onLongPressStart(reminder.id)}
      onTouchEnd={onLongPressEnd}
      onTouchMove={onLongPressEnd}
    >
      {/* Left indicator */}
      <div className="flex shrink-0 flex-col items-center pt-0.5">
        {selectionMode && !isDone && reminder.access !== "shared" ? (
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-400 text-violet-600"
            checked={selected}
            onChange={() => onSelect(reminder.id)}
            aria-label={`Select ${reminder.title}`}
          />
        ) : isDone ? (
          /* Green checkmark circle for done */
          <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: "#10b981" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
              <path d="m5 12 4 4 10-10" />
            </svg>
          </span>
        ) : (
          <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: circleColor }} />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Title row */}
        <div className="flex items-start justify-between gap-1">
          <p className={`text-[14px] font-semibold leading-snug ${isDone ? "text-slate-400 line-through" : "text-slate-900"}`}>
            {reminder.title}
            {(reminder.priority ?? 0) > 0 && (
              <span className="ml-1 text-amber-400">{"★".repeat(reminder.priority ?? 0)}</span>
            )}
          </p>
        </div>

        {/* Time row */}
        <p className={`mt-0.5 text-[11px] font-medium ${
          tab === "missed" ? "text-rose-500" :
          tab === "today"  ? "text-amber-500" :
          isDone           ? "text-emerald-500" :
          "text-slate-400"
        }`}>
          {tab === "missed"
            ? `Due at ${new Date(reminder.dueAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ${overdueLabel}`
            : timeLabel}
        </p>

        {/* Tags row */}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* Status tag */}
          {tab !== "done" && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                tab === "missed" ? "bg-rose-50 text-rose-600" :
                tab === "today"  ? "bg-amber-50 text-amber-600" :
                tab === "tomorrow" ? "bg-violet-50 text-violet-600" :
                "bg-slate-100 text-slate-500"
              }`}
              data-testid="reminder-state-label"
            >
              {reminderStateLabel(reminder)}
            </span>
          )}
          {/* Shared tag */}
          {reminder.access === "shared" && (
            <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-sky-600">
              Shared
            </span>
          )}
          {/* ADHOC / Task tag */}
          {isAdhoc ? (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500">ADHOC</span>
          ) : (
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold text-indigo-600">
              {linkedTaskTitle}
            </span>
          )}
          {/* Recurrence tag — tells the user (and the admin) at a glance
              whether this reminder repeats and how often. */}
          {(() => {
            const rec = reminder.recurrence;
            if (rec === "daily" || rec === "weekly" || rec === "monthly") {
              const tone =
                rec === "daily" ? "bg-emerald-50 text-emerald-700"
                : rec === "weekly" ? "bg-teal-50 text-teal-700"
                : "bg-cyan-50 text-cyan-700";
              return (
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${tone}`}>
                  ↻ {rec}
                </span>
              );
            }
            return (
              <span className="rounded-full bg-slate-50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500">
                One-time
              </span>
            );
          })()}
          {/* Domain tag */}
          {reminder.domain && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase"
              style={{ background: `${domainColor}18`, color: domainColor }}
            >
              {reminder.domain}
            </span>
          )}
        </div>

        {/* Notes */}
        {reminder.notes && !isDone && (
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{reminder.notes}</p>
        )}

        {/* Action buttons */}
        {!isDone && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={onMarkDone}
              data-testid="reminder-status-button"
              className="flex items-center gap-1 rounded-full bg-emerald-500 px-2.5 py-1 text-[10px] font-bold text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="m5 12 4 4 10-10"/></svg>
              Done
            </button>
            <button
              type="button"
              onClick={onEdit}
              data-testid="reminder-edit-button"
              className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-bold text-slate-600"
            >
              Edit
            </button>
            {reminder.access !== "shared" && (
              <button
                type="button"
                onClick={onShare}
                data-testid="reminder-share-button"
                className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-700"
              >
                Share
              </button>
            )}
            {tab !== "done" && (
              <button
                type="button"
                onClick={onSnooze}
                className="rounded-full border border-slate-200 px-2.5 py-1 text-[10px] font-bold text-slate-500"
              >
                +1h
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              data-testid="reminder-delete-button"
              className="rounded-full border border-rose-100 bg-rose-50 px-2.5 py-1 text-[10px] font-bold text-rose-600"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export function DashboardWorkspace({ userId }: WorkspaceProps) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const searchParams = useSearchParams();
  const notifUrlHandledRef = useRef<string | null>(null);
  const shareBatchUrlHandledRef = useRef<string | null>(null);
  const [reminders, setReminders, remindersLoaded] = usePersistentReminders(userId);
  const [dueNotifPrefs, setDueNotifPrefs] = useState<DueNotificationPrefs>(() =>
    loadDueNotificationPrefs(),
  );
  const [notifUiTick, setNotifUiTick] = useState(0);
  const [dueNotifBannerDismissed, setDueNotifBannerDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const userIdRef = useRef(userId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isHistoryLoaded, setIsHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isListOpen, setIsListOpen] = useState(false);
  const [isSnapshotOpen, setIsSnapshotOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [isClearingChat, setIsClearingChat] = useState(false);
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [batchJson, setBatchJson] = useState("");
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [editingReminderId, setEditingReminderId] = useState<string | null>(
    null,
  );
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);
  const [newTitle, setNewTitle] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newTime, setNewTime] = useState("");
  const [newRecurrence, setNewRecurrence] =
    useState<ReminderRecurrence>("none");
  const [newNotes, setNewNotes] = useState("");
  const [pendingCreateDraft, setPendingCreateDraft] =
    useState<PendingCreateDraft | null>(null);
  const [pendingConfirmAction, setPendingConfirmAction] =
    useState<{ type: "mark_done" | "delete_reminder" | "edit_reminder"; targetId?: string; targetTitle?: string; targetIds?: string[]; newTitle?: string; newNotes?: string } | null>(null);
  /** Tracks an in-progress disambiguation: user was asked "which one?" for any CRUD op */
  const [pendingDisambig, setPendingDisambig] = useState<
    | { op: "mark_done"; candidateIds: string[] }
    | { op: "delete"; candidateIds: string[] }
    | { op: "reschedule"; candidateIds: string[]; pendingDueAt: string }
    | { op: "edit"; candidateIds: string[]; pendingField: "title" | "notes"; pendingValue: string }
    | { op: "snooze"; candidateIds: string[]; pendingDelayMinutes: number }
    | null
  >(null);
  const [recentListedIds, setRecentListedIds] = useState<string[]>([]);
  const [pendingTimeSuggestion, setPendingTimeSuggestion] = useState<{
    title: string;
    suggestedDueAt: string;
    priority?: number;
    domain?: string;
    recurrence?: string;
  } | null>(null);
  const [createFormError, setCreateFormError] = useState<string | null>(null);
  const [showReminderSuccess, setShowReminderSuccess] = useState(false);
  const [reminderSuccessInfo, setReminderSuccessInfo] = useState<{ title: string; time: string } | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState<
    FollowUpQuestion[]
  >([]);
  const [showSuggestedQuestions, setShowSuggestedQuestions] = useState(true);
  const [reminderListTab, setReminderListTab] = useState<ReminderListTab>(
    "all",
  );
  const [reminderListTabDesktop, setReminderListTabDesktop] = useState<ReminderListTab>("missed");
  const [reminderSearchQuery, setReminderSearchQuery] = useState("");
  const [sharedFromFilter, setSharedFromFilter] = useState<"all" | string>(
    "all",
  );
  const [sentToFilter, setSentToFilter] = useState<"all" | string>("all");
  const [isTasksOpen, setIsTasksOpen] = useState(false);
  const [taskMode, setTaskMode] = useState<"browse" | "create">("browse");
  const [taskTab, setTaskTab] = useState<"missed" | "pending" | "done" | "all">(
    "pending",
  );
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
  const [taskFormTitle, setTaskFormTitle] = useState("");
  const [taskFormDue, setTaskFormDue] = useState(() =>
    currentDateTimeLocalValue(),
  );
  const [taskFormNotes, setTaskFormNotes] = useState("");
  const [taskFormError, setTaskFormError] = useState<string | null>(null);
  const [reminderStars, setReminderStars] = useState(0);
  const [taskStars, setTaskStars] = useState(0);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskActionWarning, setTaskActionWarning] =
    useState<TaskActionWarning | null>(null);
  const [pendingReminderCardDelete, setPendingReminderCardDelete] =
    useState<{ id: string; title: string } | null>(null);
  const [reminderLinkedTaskId, setReminderLinkedTaskId] = useState("");
  const [reminderDomain, setReminderDomain] = useState<"" | LifeDomain>("");
  const [reminderTaskFilter, setReminderTaskFilter] = useState<
    "all" | "adhoc" | string
  >("all");
  const [taskFormDomain, setTaskFormDomain] = useState<"" | LifeDomain>("");
  /** False until user focuses/changes due — then live "now" updates stop for new tasks. */
  const [taskDueUserEdited, setTaskDueUserEdited] = useState(false);
  const [showReminderInlineTask, setShowReminderInlineTask] = useState(false);
  const [reminderInlineTaskTitle, setReminderInlineTaskTitle] = useState("");
  const [reminderInlineTaskDue, setReminderInlineTaskDue] = useState("");
  const [reminderInlineTaskSaving, setReminderInlineTaskSaving] =
    useState(false);
  const [rescheduleReminder, setRescheduleReminder] = useState<{
    messageId: string;
    reminderId: string;
    title: string;
    value: string;
    error: string | null;
  } | null>(null);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const shareToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reminderSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [shareReminderIds, setShareReminderIds] = useState<string[]>([]);
  const [directoryUsers, setDirectoryUsers] = useState<DirectoryUser[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [selectedShareUserIds, setSelectedShareUserIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [shareSending, setShareSending] = useState(false);
  const [reminderSelectionMode, setReminderSelectionMode] = useState(false);
  const [selectedReminderIds, setSelectedReminderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [shareInbox, setShareInbox] = useState<ShareInboxRow[]>([]);
  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [walkthroughStepIndex, setWalkthroughStepIndex] = useState(0);
  const walkthroughLoadingRef = useRef(false);
  const isAnyOverlayOpen =
    isSnapshotOpen ||
    isCreateOpen ||
    isListOpen ||
    isShareOpen ||
    isTasksOpen ||
    isImportOpen ||
    isBatchOpen;
  /** DOM timer id; avoid NodeJS.Timeout vs number mismatch in mixed typings. */
  const reminderLongPressTimerRef = useRef<number | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const briefingRanRef = useRef(false);
  const openingSummaryAppliedRef = useRef(false);
  const missedRemindersAppliedRef = useRef(false);
  const resetTaskFormRef = useRef<() => void>(() => {});
  const briefingPlaybackActiveRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Forward ref so flushChatHistoryToServer (declared before showShareToast) can access it
  const showShareToastRef = useRef<((msg: string) => void) | null>(null);
  const remindersRef = useRef(reminders);
  remindersRef.current = reminders;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [briefingStreaming, setBriefingStreaming] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatFormRef = useRef<HTMLFormElement>(null);
  const quickSubmitTextRef = useRef<string | null>(null);
  /** When false, do not auto-scroll on new/streaming content so the user can read history. */
  const chatPinnedToBottomRef = useRef(true);
  /** After clear chat, ignore poll merges briefly so in-flight GETs cannot restore deleted history. */
  const skipRemotePollMergeUntilRef = useRef(0);
  const isHistoryLoadedRef = useRef(false);

  messagesRef.current = messages;
  userIdRef.current = userId;
  isHistoryLoadedRef.current = isHistoryLoaded;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("dashboard:reminders-changed", {
        detail: {
          reminders: reminders.map((reminder) => ({
            id: reminder.id,
            dueAt: reminder.dueAt,
            status: reminder.status,
          })),
        },
      }),
    );
  }, [reminders]);

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
      // Non-blocking: show a subtle toast so the user knows history wasn't saved.
      // Use the ref-forwarded handler to avoid declaration-order issues.
      showShareToastRef.current?.("Chat history couldn't be saved — check your connection.");
    });
  }, []);

  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    chatPinnedToBottomRef.current = gap <= 120;
  }, []);

  const runBriefingStream = useCallback(
    (recordAutoBriefing = false) => {
      if (!isHistoryLoaded || briefingPlaybackActiveRef.current) return;
      briefingPlaybackActiveRef.current = true;
      setBriefingStreaming(true);
      chatPinnedToBottomRef.current = true;

      const taskBrief: TaskItemBrief[] = tasksRef.current.map((t) => ({
        id: t.id,
        title: t.title,
        dueAt: t.dueAt,
        status: t.status,
        priority: t.priority,
      }));
      const parts = buildBriefingParts(
        remindersRef.current,
        user?.firstName ?? null,
        taskBrief,
      );

      setMessages((prev) =>
        prev.filter((m) => m.id !== "starter" && m.meta?.kind !== "briefing"),
      );

      setMessages((prev) => [
        ...prev,
        ...parts.map((part, index) => ({
          id: `briefing-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}`,
          role: "assistant" as const,
          content: part.text,
          createdAt: new Date().toISOString(),
          meta: {
            kind: "briefing" as const,
            briefingSection: part.section,
            skipPersist: true,
          },
        })),
      ]);

      briefingPlaybackActiveRef.current = false;
      setBriefingStreaming(false);
      if (recordAutoBriefing) {
        try {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem(
              `remindos:lastAutoBriefingAt:${userId}`,
              String(Date.now()),
            );
          }
        } catch {
          /* ignore */
        }
      }
    },
    [isHistoryLoaded, user?.firstName, userId],
  );

  const refreshReminders = useCallback(async () => {
    const response = await fetch("/api/reminders");
    if (!response.ok) return;
    const data = (await response.json()) as {
      reminders?: Array<Record<string, unknown>>;
    };
    setReminders(() =>
      (data.reminders ?? []).map((item) => fromApiReminder(item)),
    );
  }, [setReminders]);

  const showShareToast = useCallback((message: string) => {
    setShareToast(message);
    if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current);
    shareToastTimerRef.current = setTimeout(() => {
      setShareToast(null);
      shareToastTimerRef.current = null;
    }, 3400);
  }, []);
  // Keep ref in sync so flushChatHistoryToServer (defined earlier) can call it
  showShareToastRef.current = showShareToast;

  const refreshAfterReminderMutation = useCallback(
    async (responsePromise: Promise<Response>) => {
      const response = await responsePromise;
      if (!response.ok) {
        throw new Error("Reminder update failed");
      }
      await refreshReminders();
    },
    [refreshReminders],
  );

  const playReminderSuccessAnimation = useCallback((info?: { title: string; time: string }) => {
    setShowReminderSuccess(true);
    if (info) setReminderSuccessInfo(info);
    if (reminderSuccessTimerRef.current)
      clearTimeout(reminderSuccessTimerRef.current);
    reminderSuccessTimerRef.current = setTimeout(() => {
      setShowReminderSuccess(false);
      setReminderSuccessInfo(null);
      reminderSuccessTimerRef.current = null;
    }, 2200);
  }, []);

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
      const data = (await res.json()) as { delivered?: number; error?: string };
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
      setReminderSelectionMode(false);
      setSelectedReminderIds(new Set());
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

  const toggleReminderSelect = useCallback((id: string) => {
    setSelectedReminderIds((prev) => {
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

  useEffect(() => {
    if (isListOpen) void loadShareInbox();
  }, [isListOpen, loadShareInbox]);

  // Auto-scroll the active tab into view when the overlay opens or tab changes
  useEffect(() => {
    if (!isListOpen) return;
    const activeTabEl = document.querySelector(
      `[data-testid="reminder-tab-${reminderListTab}"]`,
    );
    if (activeTabEl) {
      activeTabEl.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "nearest", inline: "center" });
    }
  }, [isListOpen, reminderListTab]);

  const refreshRemindersRef = useRef(refreshReminders);
  refreshRemindersRef.current = refreshReminders;

  const refreshTasks = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks");
      if (!response.ok) return;
      const data = (await response.json()) as {
        tasks?: Array<Record<string, unknown>>;
      };
      setTasks((data.tasks ?? []).map((item) => fromApiTask(item)));
    } finally {
      setTasksLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [userId, refreshTasks]);

  const getPendingLinkedReminderCount = useCallback(
    (taskId: string) =>
      reminders.filter(
        (reminder) =>
          reminder.linkedTaskId === taskId && reminder.status === "pending",
      ).length,
    [reminders],
  );

  const executeTaskStatusToggle = useCallback(
    async (task: TaskRow) => {
      try {
        await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: task.status === "done" ? "pending" : "done",
          }),
        });
        await refreshTasks();
      } catch {
        setTaskFormError("Could not update task. Try again.");
      }
    },
    [refreshTasks],
  );

  const executeTaskDelete = useCallback(
    async (task: TaskRow) => {
      try {
        const response = await fetch(`/api/tasks/${task.id}`, {
          method: "DELETE",
        });
        const data = (await response.json().catch(() => ({}))) as {
          unlinkedReminderCount?: number;
        };
        await refreshTasks();
        await refreshReminders();
        if ((data.unlinkedReminderCount ?? 0) > 0) {
          showShareToast(
            `Deleted "${task.title}" and kept ${data.unlinkedReminderCount} reminder${
              data.unlinkedReminderCount === 1 ? "" : "s"
            } as ADHOC.`,
          );
        }
      } catch {
        setTaskFormError("Could not delete task. Try again.");
      }
    },
    [refreshReminders, refreshTasks, showShareToast],
  );

  const requestTaskStatusToggle = useCallback(
    (task: TaskRow) => {
      const pendingReminderCount = getPendingLinkedReminderCount(task.id);
      if (task.status === "pending" && pendingReminderCount > 0) {
        setTaskActionWarning({
          task,
          action: "complete",
          pendingReminderCount,
        });
        return;
      }
      void executeTaskStatusToggle(task);
    },
    [executeTaskStatusToggle, getPendingLinkedReminderCount],
  );

  const requestTaskDelete = useCallback(
    (task: TaskRow) => {
      const pendingReminderCount = getPendingLinkedReminderCount(task.id);
      if (pendingReminderCount > 0) {
        setTaskActionWarning({
          task,
          action: "delete",
          pendingReminderCount,
        });
        return;
      }
      void executeTaskDelete(task);
    },
    [executeTaskDelete, getPendingLinkedReminderCount],
  );

  const confirmTaskWarning = useCallback(() => {
    if (!taskActionWarning) return;
    const { action, task } = taskActionWarning;
    setTaskActionWarning(null);
    if (action === "complete") {
      void executeTaskStatusToggle(task);
      return;
    }
    void executeTaskDelete(task);
  }, [executeTaskDelete, executeTaskStatusToggle, taskActionWarning]);

  useEffect(() => {
    try {
      if (
        typeof localStorage !== "undefined" &&
        localStorage.getItem(SHOW_SUGGESTED_QUESTIONS_KEY) === "0"
      ) {
        setShowSuggestedQuestions(false);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const runReminderQuickAction = useCallback(
    async (reminderId: string, action: "delete" | "done" | "snooze") => {
      if (action === "delete") {
        // Show confirmation dialog instead of immediately deleting
        const reminder = reminders.find((r) => r.id === reminderId);
        setPendingReminderCardDelete({ id: reminderId, title: reminder?.title ?? "this reminder" });
        return;
      } else if (action === "done") {
        await refreshAfterReminderMutation(
          fetch(`/api/reminders/${reminderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done" }),
          }),
        );
      } else {
        await refreshAfterReminderMutation(
          fetch(`/api/reminders/${reminderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dueAt: Date.now() + 60 * 60 * 1000 }),
          }),
        );
      }
    },
    [refreshAfterReminderMutation, reminders],
  );

  useEffect(() => {
    if (!isLoading) return;
    const interval = window.setInterval(() => {
      setLoadingTextIndex((prev) => (prev + 1) % loadingTexts.length);
    }, 2200);
    return () => window.clearInterval(interval);
  }, [isLoading]);

  useEffect(() => {
    const loadHistory = async () => {
      const fallbackStarter = () =>
        setMessages([
          { ...STARTER_MESSAGE, createdAt: new Date().toISOString() },
        ]);

      const syncServer = (list: ChatMessage[]) => {
        const persistable = dedupeMessagesById(list).filter(
          (m) => !m.meta?.skipPersist,
        );
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
            item.id &&
            item.content &&
            item.createdAt &&
            (item.role === "user" ||
              item.role === "assistant" ||
              item.role === "system"),
        );
        if (parsed.length > 0) {
          const next = dedupeMessagesById(parsed);
          setMessages(next);
          saveChatBackup(userId, next);
        } else {
          // Server is empty — trust it (do not restore localStorage backup or cleared chat comes back on refresh).
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
  }, [userId]);

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

  useEffect(() => {
    if (!isHistoryLoaded || isLoading) return;
    flushChatHistoryToServer();
  }, [isLoading, isHistoryLoaded, flushChatHistoryToServer]);

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
            item.id &&
            item.content &&
            item.createdAt &&
            (item.role === "user" ||
              item.role === "assistant" ||
              item.role === "system"),
        );
        setMessages((prev) => {
          if (Date.now() < skipRemotePollMergeUntilRef.current) {
            return prev;
          }
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
  }, [isHistoryLoaded, briefingStreaming]);

  useEffect(() => {
    if (briefingStreaming) return;
    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === "user")?.content;
    const taskBrief: TaskItemBrief[] = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: t.dueAt,
      status: t.status,
      priority: t.priority,
    }));
    setFollowUpQuestions(
      buildFollowUpQuestions({
        reminders,
        tasks: taskBrief,
        lastUserMessage: lastUser,
        firstName: user?.firstName,
      }),
    );
  }, [messages, reminders, tasks, user?.firstName, briefingStreaming]);

  useEffect(() => {
    return () => {
      if (shareToastTimerRef.current) clearTimeout(shareToastTimerRef.current);
      if (reminderSuccessTimerRef.current)
        clearTimeout(reminderSuccessTimerRef.current);
    };
  }, []);

  useEffect(() => {
    briefingRanRef.current = false;
    openingSummaryAppliedRef.current = false;
    missedRemindersAppliedRef.current = false;
    setTasksLoaded(false);
  }, [userId]);

  useEffect(() => {
    if (!isHistoryLoaded || !remindersLoaded || !tasksLoaded) return;
    if (openingSummaryAppliedRef.current) return;
    const summary = buildOpeningSummaryMessage({
      reminders,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        status: task.status,
        priority: task.priority,
      })),
      firstName: user?.firstName,
    });
    setMessages((prev) => [
      summary,
      ...prev.filter(
        (message) => message.id !== "starter" && message.meta?.kind !== "opening_summary",
      ),
    ]);
    openingSummaryAppliedRef.current = true;
  }, [isHistoryLoaded, remindersLoaded, tasksLoaded, reminders, tasks, user?.firstName]);

  useEffect(() => {
    if (!isHistoryLoaded || !remindersLoaded || !tasksLoaded) return;
    if (missedRemindersAppliedRef.current) return;
    if (!openingSummaryAppliedRef.current) return;
    // Opening summary already contains ordered sections including overdue today.
    // Prevent duplicate missed reminder bubbles on refresh/reopen.
    missedRemindersAppliedRef.current = true;
  }, [isHistoryLoaded, remindersLoaded, tasksLoaded, reminders]);

  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    if (!chatPinnedToBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [messages, isLoading, briefingStreaming]);

  const cueInitRef = useRef(false);
  const lastCueMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isHistoryLoaded) return;
    const latest = [...messages].reverse().find((m) => m.role !== "user");
    if (!latest) return;
    if (!cueInitRef.current) {
      cueInitRef.current = true;
      lastCueMessageIdRef.current = latest.id;
      return;
    }
    if (lastCueMessageIdRef.current === latest.id) return;
    lastCueMessageIdRef.current = latest.id;
    void playUiCue(
      latest.meta?.kind === "briefing" ? "briefing" : "notification",
    );
  }, [messages, isHistoryLoaded]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const maxHeight = Math.min(window.innerHeight * 0.28, 144);
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(nextHeight, 44)}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input, briefingStreaming, editingMessageId, replyTarget]);

  const inviteQueryParam = searchParams?.get("invite");

  useEffect(() => {
    const token = inviteQueryParam?.trim();
    if (!token || !isHistoryLoaded) return;

    const handledKey = `remindos:inviteUiHandled:${token}`;
    if (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem(handledKey)
    ) {
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", "/dashboard");
      }
      return;
    }

    // Strip ?invite= from the URL immediately so this effect does not re-fire in a loop
    // (each run would otherwise append another error/success message).
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", "/dashboard");
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/reminders/share/${encodeURIComponent(token)}`,
          {
            method: "POST",
          },
        );
        const data = (await res.json()) as { error?: string; title?: string };
        if (cancelled) return;

        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(handledKey, "1");
        }

        if (!res.ok) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: data.error ?? "Could not accept that invite.",
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }

        await refreshRemindersRef.current();
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.title
              ? `You're in on "${data.title}". Shared reminders appear in your list.`
              : "Invite accepted.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch {
        if (!cancelled) {
          if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem(handledKey, "1");
          }
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content:
                "Could not accept the invite. Try again from chat with the link.",
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inviteQueryParam, isHistoryLoaded]);

  const shareBatchAction = searchParams?.get("shareBatchAction");
  const batchKeyParam = searchParams?.get("batchKey");

  useEffect(() => {
    const act = shareBatchAction?.trim();
    const key = batchKeyParam?.trim();
    if (!act || !key || !isHistoryLoaded) return;
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
          await refreshRemindersRef.current();
          void loadShareInbox();
        }
      } catch {
        shareBatchUrlHandledRef.current = null;
      } finally {
        if (typeof window !== "undefined") {
          window.history.replaceState(window.history.state, "", "/dashboard");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    shareBatchAction,
    batchKeyParam,
    isHistoryLoaded,
    loadShareInbox,
    showShareToast,
  ]);

  useEffect(() => {
    if (!isHistoryLoaded) return;
    void syncReminderPushSubscription();
  }, [isHistoryLoaded]);

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

  useEffect(() => {
    if (!isHistoryLoaded) return;
    for (const m of messages) {
      if (m.role !== "system") continue;
      if (!/\bwas accepted by\b|\byou joined\b/i.test(m.content)) continue;
      if (!shouldNotifyForCollaboration(m.id, m.createdAt)) continue;
      const title = /\bwas accepted by\b/i.test(m.content)
        ? "Reminder shared"
        : "Shared reminder";
      void showCollaborationNotification(
        title,
        m.content.slice(0, 200),
        `collab-${m.id}`,
      );
    }
  }, [messages, isHistoryLoaded]);

  useEffect(() => {
    const rid = searchParams?.get("reminderId")?.trim();
    const act = searchParams?.get("notifAction")?.trim();
    if (!rid) return;
    const sig = `${act ?? ""}:${rid}`;
    if (notifUrlHandledRef.current === sig) return;
    if (!act || act === "open") {
      notifUrlHandledRef.current = sig;
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", "/dashboard");
      }
      return;
    }
    if (act !== "done" && act !== "snooze" && act !== "delete") return;
    notifUrlHandledRef.current = sig;
    void runReminderQuickAction(rid, act).finally(() => {
      const reminderTitle = remindersRef.current.find((r) => r.id === rid)?.title ?? "Reminder";
      const resolutionLine =
        act === "done"
          ? `Marked "${reminderTitle}" as done.`
          : act === "snooze"
            ? `Snoozed "${reminderTitle}" by one hour.`
            : `Deleted "${reminderTitle}".`;
      resolveDueReminderById(rid, resolutionLine);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "system",
          content:
            act === "done"
              ? `Marked **${reminderTitle}** as done from notification.`
              : act === "snooze"
                ? `Snoozed **${reminderTitle}** for 1 hour from notification.`
                : `Deleted **${reminderTitle}** from notification.`,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", "/dashboard");
      }
    });
  }, [searchParams, runReminderQuickAction]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const nav = navigator.serviceWorker;
    const handler = (event: MessageEvent) => {
      const d = event.data as {
        type?: string;
        action?: string;
        reminderId?: string;
        batchKey?: string;
        title?: string;
      };
      if (d?.type === "SHARE_INVITE_NOTIF" && d.batchKey) {
        const a = d.action ?? "open";
        if (a === "accept") void joinShareBatch(d.batchKey);
        else if (a === "deny") void dismissShareBatch(d.batchKey);
        return;
      }
      // Play sound for push-triggered notification actions received via SW
      if (d?.type === "REMINDER_NOTIF") {
        const notifType = (d as { notifType?: string }).notifType;
        if (notifType === "pre_due_reminder" && dueNotifPrefs.soundEnabled !== false) playPreDuePing();
        if (notifType === "overdue_nudge" && dueNotifPrefs.soundEnabled !== false) playOverdueNudge();
      }
      if (d?.type !== "REMINDER_NOTIF" || !d.reminderId) return;
      const a = d.action ?? "open";
      if (a === "open") return;
      if (a === "done" || a === "snooze" || a === "delete") {
        const reminderId = d.reminderId;
        void runReminderQuickAction(reminderId, a).then(() => {
          const reminderTitle =
            remindersRef.current.find((r) => r.id === reminderId)?.title ??
            d.title ??
            "Reminder";
          const resolutionLine =
            a === "done"
              ? `Marked "${reminderTitle}" as done.`
              : a === "snooze"
                ? `Snoozed "${reminderTitle}" by one hour.`
                : `Deleted "${reminderTitle}".`;
          resolveDueReminderById(reminderId, resolutionLine);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "system",
              content:
                a === "done"
                  ? `Marked **${reminderTitle}** as done from notification.`
                  : a === "snooze"
                    ? `Snoozed **${reminderTitle}** for 1 hour from notification.`
                    : `Deleted **${reminderTitle}** from notification.`,
              createdAt: new Date().toISOString(),
            },
          ]);
        });
      }
    };
    nav.addEventListener("message", handler);
    return () => nav.removeEventListener("message", handler);
  }, [runReminderQuickAction, joinShareBatch, dismissShareBatch]);

  useEffect(() => {
    try {
      if (
        typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem("remindos:dueNotifBannerDismissed") === "1"
      ) {
        setDueNotifBannerDismissed(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onVis = () => setNotifUiTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!isHistoryLoaded) return;
    const tick = () => {
      const now = new Date();
      for (const r of reminders) {
        if (r.status !== "pending") continue;
        if (!isDueThisMinute(r.dueAt, now)) continue;
        const key = dueMinuteKey(r);

        if (!readDueShown().has(key)) {
          markDueShown(key);
          const msg: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Reminder due: ${r.title}`,
            createdAt: new Date().toISOString(),
            meta: {
              kind: "due_reminder",
              reminderId: r.id,
              dueAt: new Date(r.dueAt).getTime(),
              title: r.title,
              notes: r.notes,
            },
          };
          setMessages((prev) => [...prev, msg]);
          // Sound alert (if user has sound enabled — checked via prefs)
          if (dueNotifPrefs.soundEnabled !== false) {
            playDueChime();
          }
          if (
            typeof navigator !== "undefined" &&
            navigator.vibrate &&
            isCompactViewport()
          ) {
            navigator.vibrate(80);
          }
        }

        if (
          shouldShowSystemDueNotification(dueNotifPrefs) &&
          !readNotifDueSent(key)
        ) {
          markNotifDueSent(key);
          void (async () => {
            try {
              await showDueReminderSystemNotification(r, key);
            } catch {
              /* iOS / unsupported */
            }
          })();
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 12000);
    return () => window.clearInterval(id);
  }, [reminders, isHistoryLoaded, dueNotifPrefs, notifUiTick]);

  const grouped = useMemo(() => {
    const now = new Date();
    const next = {
      missed: [] as ReminderItem[],
      today: [] as ReminderItem[],
      tomorrow: [] as ReminderItem[],
      upcoming: [] as ReminderItem[],
      done: [] as ReminderItem[],
    };

    for (const reminder of reminders) {
      const bucket = getReminderBucket(reminder, now);
      if (bucket === "missed") {
        next.missed.push(reminder);
        continue;
      }
      if (bucket === "today") next.today.push(reminder);
      else if (bucket === "tomorrow") next.tomorrow.push(reminder);
      else if (bucket === "upcoming") next.upcoming.push(reminder);
      else if (bucket === "done") next.done.push(reminder);
    }

    return {
      missed: next.missed,
      today: next.today,
      tomorrow: next.tomorrow,
      upcoming: next.upcoming,
      done: next.done,
    };
  }, [reminders]);

  const snapshot = useMemo(
    () => ({
      pending: reminders.filter((r) => r.status !== "done").length,
      done: reminders.filter((r) => r.status === "done").length,
      missed: grouped.missed.length,
      today: grouped.today.length,
      tomorrow: grouped.tomorrow.length,
    }),
    [grouped.missed.length, grouped.today.length, grouped.tomorrow.length, reminders],
  );

  const nextTwoHoursReminders = useMemo(() => {
    const now = new Date();
    return reminders
      .filter((reminder) => isNextTwoHoursReminder(reminder, now))
      .slice()
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
  }, [reminders]);

  const tasksGrouped = useMemo(() => {
    const now = new Date();
    const byPriDue = (a: TaskRow, b: TaskRow) => {
      const pa = typeof a.priority === "number" ? a.priority : 0;
      const pb = typeof b.priority === "number" ? b.priority : 0;
      if (pa !== pb) return pb - pa;
      const da = a.dueAt
        ? new Date(a.dueAt).getTime()
        : Number.MAX_SAFE_INTEGER;
      const db = b.dueAt
        ? new Date(b.dueAt).getTime()
        : Number.MAX_SAFE_INTEGER;
      return da - db;
    };
    return {
      missed: tasks
        .filter((t) => taskBucket(t, now) === "missed")
        .slice()
        .sort(byPriDue),
      pending: tasks
        .filter(
          (t) => t.status === "pending" && taskBucket(t, now) !== "missed",
        )
        .slice()
        .sort(byPriDue),
      done: tasks
        .filter((t) => t.status === "done")
        .slice()
        .sort(byPriDue),
    };
  }, [tasks]);

  const taskTitleById = useMemo(
    () => Object.fromEntries(tasks.map((t) => [t.id, t.title] as const)),
    [tasks],
  );

  const matchesReminderSearch = useCallback(
    (reminder: ReminderItem, query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const linkedTaskTitle = reminder.linkedTaskId
        ? taskTitleById[reminder.linkedTaskId] ?? ""
        : "";
      const hay = [
        reminder.title,
        reminder.notes ?? "",
        reminder.recurrence ?? "",
        reminder.domain ?? "",
        linkedTaskTitle,
        reminder.status,
        reminder.access ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    },
    [taskTitleById],
  );

  const reminderListRows = useMemo(() => {
    if (reminderListTab === "all") {
      let rows = reminders;
      if (reminderTaskFilter === "adhoc") {
        rows = rows.filter((r) => isAdhocReminder(r));
      } else if (reminderTaskFilter !== "all") {
        rows = rows.filter((r) => r.linkedTaskId === reminderTaskFilter);
      }
      return rows.filter((r) => matchesReminderSearch(r, reminderSearchQuery));
    }
    if (reminderListTab === "next2hours") {
      let rows = nextTwoHoursReminders.filter((r) => matchesReminderSearch(r, reminderSearchQuery));
      if (reminderTaskFilter === "adhoc") {
        return rows.filter((r) => isAdhocReminder(r));
      }
      if (reminderTaskFilter !== "all") {
        return rows.filter((r) => r.linkedTaskId === reminderTaskFilter);
      }
      return rows;
    }
    if (reminderListTab === "shared") {
      let rows = reminders.filter((r) => r.access === "shared");
      if (sharedFromFilter !== "all") {
        rows = rows.filter((r) => r.ownerUserId === sharedFromFilter);
      }
      rows = rows.filter((r) => matchesReminderSearch(r, reminderSearchQuery));
      if (reminderTaskFilter === "adhoc")
        return rows.filter((r) => isAdhocReminder(r));
      if (reminderTaskFilter !== "all") {
        return rows.filter((r) => r.linkedTaskId === reminderTaskFilter);
      }
      return rows;
    }
    if (reminderListTab === "sent") {
      let rows = reminders.filter(
        (r) => r.access === "owner" && r.outgoingShared,
      );
      if (sentToFilter !== "all") {
        rows = rows.filter((r) =>
          r.shareRecipients?.some((p) => p.userId === sentToFilter),
        );
      }
      rows = rows.filter((r) => matchesReminderSearch(r, reminderSearchQuery));
      if (reminderTaskFilter === "adhoc")
        return rows.filter((r) => isAdhocReminder(r));
      if (reminderTaskFilter !== "all") {
        return rows.filter((r) => r.linkedTaskId === reminderTaskFilter);
      }
      return rows;
    }
    const base = grouped[reminderListTab].filter((r) => matchesReminderSearch(r, reminderSearchQuery));
    if (reminderTaskFilter === "all") return base;
    if (reminderTaskFilter === "adhoc")
      return base.filter((r) => isAdhocReminder(r));
    return base.filter((r) => r.linkedTaskId === reminderTaskFilter);
  }, [
    grouped,
    reminderListTab,
    reminderTaskFilter,
    reminders,
    reminderSearchQuery,
    sharedFromFilter,
    sentToFilter,
    matchesReminderSearch,
    nextTwoHoursReminders,
  ]);

  const sharedTabCount = useMemo(
    () => reminders.filter((r) => r.access === "shared").length,
    [reminders],
  );
  const sentTabCount = useMemo(
    () =>
      reminders.filter((r) => r.access === "owner" && r.outgoingShared).length,
    [reminders],
  );

  const sharedFromOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const r of reminders) {
      if (r.access === "shared" && r.ownerUserId) ids.add(r.ownerUserId);
    }
    return [...ids];
  }, [reminders]);

  const sentRecipientOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reminders) {
      if (r.access !== "owner" || !r.shareRecipients?.length) continue;
      for (const p of r.shareRecipients) {
        if (!map.has(p.userId)) map.set(p.userId, p.displayName);
      }
    }
    return [...map.entries()];
  }, [reminders]);

  const applyAction = (action: AgentAction) => {
    // Clear stale pending state for every action type except pending_confirm (which sets it)
    // This prevents a stale "yes" from firing a previously abandoned confirmation.
    if (action.type !== "pending_confirm") {
      setPendingConfirmAction(null);
    }
    // Clear stale listed IDs for every non-list action — prevents ordinal resolution
    // from targeting a reminder list from many turns ago.
    if (action.type !== "list_reminders") {
      setRecentListedIds([]);
    }

    if (action.type === "create_reminder" && action.title && action.dueAt) {
      setPendingCreateDraft(null);
      setPendingDisambig(null);
      const title = action.title;
      const dueAt = action.dueAt;
      const isDuplicate = reminders.some(
        (item) =>
          item.status === "pending" &&
          item.title.trim().toLowerCase() === title.trim().toLowerCase() &&
          new Date(item.dueAt).getTime() === new Date(dueAt).getTime(),
      );
      if (isDuplicate) return;

      void (async () => {
        const validRecurrences = ["none", "daily", "weekly", "monthly"] as const;
        const validDomains = ["health", "finance", "career", "hobby", "fun"] as const;
        try {
          const res = await fetch("/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              dueAt: new Date(dueAt).getTime(),
              notes: action.notes?.trim() ? action.notes : undefined,
              recurrence: validRecurrences.includes(action.recurrence as typeof validRecurrences[number])
                ? action.recurrence
                : "none",
              priority:
                typeof action.priority === "number" && action.priority >= 1 && action.priority <= 5
                  ? action.priority
                  : 3,
              domain: validDomains.includes(action.domain as typeof validDomains[number])
                ? action.domain
                : undefined,
              linkedTaskId: action.linkedTaskId?.trim() ? action.linkedTaskId : undefined,
            }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            created?: boolean;
            error?: string;
          };
          if (!res.ok) {
            showShareToast(data.error ?? "Could not save the reminder. Please try again.");
            return;
          }
          await refreshReminders();
          playReminderSuccessAnimation();
        } catch {
          showShareToast("Could not save the reminder. Please try again.");
        }
      })();
      return;
    }

    if (action.type === "mark_done") {
      setPendingConfirmAction(null);
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) return;
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        }),
      ).catch(() => showShareToast("Could not update reminder. Try again."));
      return;
    }

    if (action.type === "delete_reminder") {
      setPendingConfirmAction(null);
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) return;
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, { method: "DELETE" }),
      ).catch(() => showShareToast("Could not delete reminder. Try again."));
      return;
    }

    if (action.type === "snooze_reminder" && typeof action.delayMinutes === "number" && action.delayMinutes > 0) {
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) return;
      const newDueAt = Date.now() + action.delayMinutes * 60_000;
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueAt: newDueAt }),
        }),
      ).catch(() => showShareToast("Could not snooze reminder. Try again."));
      return;
    }

    if (action.type === "edit_reminder" && (action.newTitle || action.newNotes !== undefined)) {
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) return;
      const patch: Record<string, unknown> = {
        priority: typeof target.priority === "number" ? target.priority : 3,
      };
      if (action.newTitle) patch.title = action.newTitle;
      if (typeof action.newNotes === "string") patch.notes = action.newNotes;
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ).catch(() => showShareToast("Could not edit reminder. Try again."));
      return;
    }

    if (action.type === "bulk_action" && action.bulkOperation && action.bulkTargetIds?.length) {
      const ids = action.bulkTargetIds;
      const op = action.bulkOperation;
      void (async () => {
        const results = await Promise.allSettled(
          ids.map((id) =>
            op === "delete"
              ? fetch(`/api/reminders/${id}`, { method: "DELETE" })
              : fetch(`/api/reminders/${id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ status: "done" }),
                }),
          ),
        );
        const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
        if (failed > 0) {
          showShareToast(`${failed} of ${ids.length} reminders could not be ${op === "delete" ? "deleted" : "marked done"}. Try again.`);
        }
        await refreshReminders();
      })();
      return;
    }

    if (action.type === "reschedule_reminder" && action.dueAt) {
      const target = reminders.find((r) =>
        matchesReminder(r, action.targetId, action.targetTitle),
      );
      if (!target) return;
      void refreshAfterReminderMutation(
        fetch(`/api/reminders/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueAt: new Date(action.dueAt).getTime() }),
        }),
      ).catch(() => showShareToast("Could not reschedule reminder. Try again."));
    }

    if (action.type === "pending_confirm" && action.pendingType) {
      setPendingConfirmAction({
        type: action.pendingType,
        targetId: action.targetId,
        targetTitle: action.targetTitle,
        targetIds: action.bulkTargetIds,
        // edit_reminder confirmation carries the new value
        newTitle: action.newTitle,
        newNotes: action.newNotes,
      });
      return;
    }

    // Gap 7: store listed IDs so the next turn can use ordinal references
    // (cleared at the top of applyAction for every non-list action)
    if (action.type === "list_reminders" && action.listedIds?.length) {
      setRecentListedIds(action.listedIds);
    }

    if (action.type === "clarify") {
      // Disambiguation clarify: user was asked "which one?" for any CRUD op.
      // Store full context so the next reply resolves the correct reminder
      // instead of accidentally starting the create-reminder wizard.
      if (action.pendingOp && action.candidateIds?.length) {
        if (action.pendingOp === "reschedule" && action.pendingDueAt) {
          setPendingDisambig({ op: "reschedule", candidateIds: action.candidateIds, pendingDueAt: action.pendingDueAt });
        } else if (action.pendingOp === "edit" && action.pendingField && action.pendingValue != null) {
          setPendingDisambig({ op: "edit", candidateIds: action.candidateIds, pendingField: action.pendingField, pendingValue: action.pendingValue });
        } else if (action.pendingOp === "snooze" && action.pendingDelayMinutes) {
          setPendingDisambig({ op: "snooze", candidateIds: action.candidateIds, pendingDelayMinutes: action.pendingDelayMinutes });
        } else if (action.pendingOp === "mark_done" || action.pendingOp === "delete") {
          setPendingDisambig({ op: action.pendingOp, candidateIds: action.candidateIds });
        }
        setPendingCreateDraft(null);
        return;
      }

      // Gap 8: if the server included a time suggestion, store it for confirmation on next turn.
      // Fix: don't activate BOTH wizard and suggestion simultaneously — pick suggestion path only,
      // skip setPendingCreateDraft so the two flows don't conflict.
      if (action.suggestedDueAt && action.title) {
        // Fix: suggestion path takes over — don't also activate the step-by-step wizard
        // which would leave both pendingTimeSuggestion AND pendingCreateDraft alive,
        // causing a spurious duplicate reminder on wizard completion.
        setPendingTimeSuggestion({
          title: action.title,
          suggestedDueAt: action.suggestedDueAt,
          priority: action.priority,
          domain: typeof action.domain === "string" ? action.domain : undefined,
          recurrence: typeof action.recurrence === "string" ? action.recurrence : undefined,
        });
        // Clear any stale wizard/disambig so it doesn't conflict
        setPendingCreateDraft(null);
        setPendingDisambig(null);
        return;
      }
      setPendingDisambig(null);
      setPendingCreateDraft({
        step: action.title ? "date" : "title",
        title: action.title,
        notes: action.notes,
      });
    }
  };

  const extractCreateTitle = (value: string) =>
    value
      .replace(/^\s*create(\s+a)?\s+reminder\s*/i, "")
      .replace(/^\s*(for|about)\s+/i, "")
      .trim();

  const hasInlineCreateDetails = (value: string) =>
    /\b(today|tomorrow|tmrw|tomorow|tommarow|day after tomorrow|after tomorrow|आज|कल|उद्या|परसों|परवा|noon|midnight)\b/i.test(
      value,
    ) ||
    /\b\d{1,2}(?:[:.]\d{2})?\s*(am|pm)\b/i.test(value) ||
    /\b\d{1,2}[:.]\d{2}\b/.test(value);

  const parseDateInput = (value: string, now: Date) => {
    const text = value
      .trim()
      .toLowerCase()
      .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
    const base = new Date(now);
    base.setHours(0, 0, 0, 0);

    if (/^(today|आज)$/.test(text)) return base.toISOString().slice(0, 10);
    if (/^(tomorrow|tmrw|tomorow|tommarow|कल|उद्या)$/.test(text)) {
      const d = new Date(base);
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    }
    if (/^(day after tomorrow|after tomorrow|परसों|परवा)$/.test(text)) {
      const d = new Date(base);
      d.setDate(d.getDate() + 2);
      return d.toISOString().slice(0, 10);
    }

    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const parsed = new Date(y, mo - 1, d);
    if (
      parsed.getFullYear() !== y ||
      parsed.getMonth() !== mo - 1 ||
      parsed.getDate() !== d
    ) {
      return null;
    }
    return `${y.toString().padStart(4, "0")}-${mo.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  };

  const parseTimeInput = (value: string) => {
    const text = value
      .trim()
      .toLowerCase()
      .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))
      .replace(/\b([ap])\.\s?m\.\b/g, "$1m");
    if (text === "noon") return "12:00";
    if (text === "midnight") return "00:00";
    if (/^(दोपहर|दुपारी)$/.test(text)) return "12:00";
    if (/^(आधी रात|मध्यरात्र)$/.test(text)) return "00:00";

    const meridiem = text.match(/\b(\d{1,2})(?:[:.]\s*(\d{2}))?\s?(am|pm)\b/i);
    if (meridiem) {
      const hourRaw = Number(meridiem[1] ?? "0");
      const minute = Number(meridiem[2] ?? "0");
      if (!Number.isFinite(hourRaw) || hourRaw < 1 || hourRaw > 12) return null;
      if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
      let hour = hourRaw % 12;
      if ((meridiem[3] ?? "am").toLowerCase() === "pm") hour += 12;
      return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    }

    const clock = text.match(/^\s*(\d{1,2})[:.]\s*(\d{2})\s*$/);
    if (clock) {
      const hour = Number(clock[1] ?? "-1");
      const minute = Number(clock[2] ?? "-1");
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    }

    const regional = text.match(
      /^\s*(\d{1,2})(?:[:.]\s*(\d{2}))?\s*(?:बजे|वाजता|वाजले)?\s*(सुबह|सकाळी|दोपहर|दुपारी|शाम|सायंकाळी|रात)?\s*$/,
    );
    if (!regional) return null;
    const rawHour = Number(regional[1] ?? "-1");
    const minute = Number(regional[2] ?? "0");
    if (rawHour < 0 || rawHour > 23 || minute < 0 || minute > 59) return null;
    const part = (regional[3] ?? "").toLowerCase();
    if (!part && !/(?:बजे|वाजता|वाजले)/i.test(text)) return null;

    let hour = rawHour;
    if (/सुबह|सकाळी/i.test(part)) {
      if (hour === 12) hour = 0;
    } else if (/दोपहर|दुपारी|शाम|सायंकाळी|रात/i.test(part)) {
      if (hour >= 1 && hour <= 11) hour += 12;
    }
    return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  };

  const pendingTaskChoices = () =>
    tasks.filter((t) => t.status === "pending").slice(0, 8);

  const taskChoicePrompt = (choices: TaskRow[]) => {
    if (choices.length === 0) {
      return "Step 3/4: Should this reminder be linked to a task? Reply " +
        '"no" for standalone.';
    }
    return [
      "Step 3/4: Which task is this reminder related to?",
      ...choices.map((t, idx) => `${idx + 1}. ${t.title}`),
      'Reply with number/name, or "no" for standalone.',
    ].join("\n");
  };

  const taskLinkQuickReplies = useMemo(
    () =>
      pendingCreateDraft?.step === "task"
        ? tasks.filter((t) => t.status === "pending").slice(0, 8)
        : [],
    [pendingCreateDraft?.step, tasks],
  );

  const handleChatSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = (quickSubmitTextRef.current ?? input).trim();
    quickSubmitTextRef.current = null;
    if (!prompt || isLoading) return;

    const dispatchAssistantResponse = async (
      messageText: string,
      responseReplyPayload: ReplyContextPayload | undefined,
      _messagesSnapshot: ChatMessage[],
    ) => {
      try {
        const inviteToken = extractInviteToken(messageText);
        if (inviteToken) {
          const res = await fetch(
            `/api/reminders/share/${encodeURIComponent(inviteToken)}`,
            {
              method: "POST",
            },
          );
          const data = (await res.json()) as { error?: string; title?: string };
          if (!res.ok) {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: data.error ?? "Could not accept that invite.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }
          await refreshReminders();
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: data.title
                ? `You're in on "${data.title}". It is now in your reminder list.`
                : "Invite accepted.",
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }

        // ─── Disambiguation resolution (all CRUD ops) ────────────────────────
        // User was asked "Which one do you mean?" — their reply is a clarifying
        // title. Resolve it here, client-side, without hitting the server so we
        // never accidentally fall into the create-reminder wizard.
        if (pendingDisambig) {
          const text = messageText.trim().toLowerCase();

          // Escape hatch: user explicitly cancels
          if (/^(cancel|nevermind|never mind|stop|abort|no|nope)\b/i.test(messageText.trim())) {
            setPendingDisambig(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Got it — operation cancelled.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          const candidates = reminders.filter((r) =>
            pendingDisambig.candidateIds.includes(r.id),
          );

          // Match strategy — require exactly ONE candidate to match to avoid
          // silently picking the wrong reminder when both share keywords.
          // Phase 1: exact substring (title fully inside text, or text inside title)
          const exactMatches = candidates.filter((r) => {
            const title = r.title.toLowerCase();
            return text.includes(title) || title.includes(text);
          });
          // Phase 2: any meaningful token (≥4 chars) from the title appears in user text
          const tokenMatches =
            exactMatches.length > 0
              ? exactMatches
              : candidates.filter((r) => {
                  const tokens = r.title
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((t) => t.length >= 4);
                  return tokens.some((token) => text.includes(token));
                });

          if (tokenMatches.length > 1) {
            // Still ambiguous — ask again with more detail
            const sample = tokenMatches.slice(0, 3).map((r) => `"${r.title}"`);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `I still can't tell which one. Please give more of the title — ${sample.join(", ")}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
            return; // keep pendingDisambig active
          }

          const match = tokenMatches[0] ?? null;

          if (!match) {
            // No candidate matched — clear context and let user retry from scratch
            setPendingDisambig(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content:
                  "I couldn't match that to any of the reminders I mentioned. Please try again.",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          // Unique match found — capture state snapshot BEFORE clearing,
          // then resolve based on op type.
          const disambigSnapshot = pendingDisambig;
          setPendingDisambig(null);
          const { op } = disambigSnapshot;

          if (op === "mark_done" || op === "delete") {
            // Needs "are you sure?" confirmation before executing
            const actionVerb = op === "mark_done" ? "mark as done" : "delete";
            setPendingConfirmAction({
              type: op === "mark_done" ? "mark_done" : "delete_reminder",
              targetId: match.id,
              targetTitle: match.title,
            });
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Are you sure you want to ${actionVerb} "${match.title}"? Reply **yes** to confirm.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else if (op === "reschedule") {
            // Execute directly — reschedule doesn't need a "are you sure?" step
            const newDueAt = disambigSnapshot.pendingDueAt;
            void refreshAfterReminderMutation(
              fetch(`/api/reminders/${match.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dueAt: new Date(newDueAt).getTime() }),
              }),
            ).catch(() => showShareToast("Could not reschedule reminder. Try again."));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Rescheduled "${match.title}" to ${new Date(newDueAt).toLocaleString()}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else if (op === "edit") {
            // Needs confirmation before applying (consistent with normal edit flow)
            const { pendingField, pendingValue } = disambigSnapshot;
            const previewValue = pendingValue.length > 40 ? `${pendingValue.slice(0, 40)}…` : pendingValue;
            setPendingConfirmAction({
              type: "edit_reminder",
              targetId: match.id,
              targetTitle: match.title,
              ...(pendingField === "title" ? { newTitle: pendingValue } : { newNotes: pendingValue }),
            });
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Change the ${pendingField} of "${match.title}" to "${previewValue}"? Reply **yes** to confirm.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          } else if (op === "snooze") {
            // Execute directly — snooze doesn't need a "are you sure?" step
            const { pendingDelayMinutes } = disambigSnapshot;
            const newDueAt = Date.now() + pendingDelayMinutes * 60_000;
            const label =
              pendingDelayMinutes >= 60
                ? `${Math.round(pendingDelayMinutes / 60)} hour${Math.round(pendingDelayMinutes / 60) !== 1 ? "s" : ""}`
                : `${pendingDelayMinutes} minute${pendingDelayMinutes !== 1 ? "s" : ""}`;
            void refreshAfterReminderMutation(
              fetch(`/api/reminders/${match.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dueAt: newDueAt }),
              }),
            ).catch(() => showShareToast("Could not snooze reminder. Try again."));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Snoozed "${match.title}" — I'll remind you again in ${label}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
          }
          return;
        }

        if (pendingCreateDraft) {
          const text = messageText.trim();

          if (pendingCreateDraft.step === "title") {
            if (!text) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "What should the reminder title be?",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "date" as const }),
              step: "date",
              title: text,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Step 1/4: What date should I set? (today / tomorrow / YYYY-MM-DD)",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "date") {
            const dateIso = parseDateInput(text, new Date());
            if (!dateIso) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "Please share a valid date: today, tomorrow, or YYYY-MM-DD.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "time" as const }),
              step: "time",
              dateIso,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Step 2/4: What time? (e.g. 8:30 PM or 20:30)",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "time") {
            const time24 = parseTimeInput(text);
            if (!time24 || !pendingCreateDraft.dateIso) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "Please share a valid time, like 8:30 PM or 20:30.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            const dueAt = new Date(`${pendingCreateDraft.dateIso}T${time24}:00`).toISOString();
            if (!Number.isFinite(new Date(dueAt).getTime()) || new Date(dueAt).getTime() <= Date.now()) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "That date/time is in the past. Please send a future time.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            const choices = pendingTaskChoices();
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "task" as const }),
              step: "task",
              dueAt,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: taskChoicePrompt(choices),
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "task") {
            const choices = pendingTaskChoices();
            let linkedTaskId = "";
            if (!/^(no|none|standalone|skip)$/i.test(text)) {
              const byIndex = Number(text);
              if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
                linkedTaskId = choices[byIndex - 1]?.id ?? "";
              } else {
                const byName = choices.find((t) => t.title.toLowerCase().includes(text.toLowerCase()));
                if (!byName) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: taskChoicePrompt(choices),
                      createdAt: new Date().toISOString(),
                    },
                  ]);
                  return;
                }
                linkedTaskId = byName.id;
              }
            }
            setPendingCreateDraft((prev) => ({
              ...(prev ?? { step: "priority" as const }),
              step: "priority",
              linkedTaskId,
            }));
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: "Step 4/4: Set priority (1 to 5 stars).",
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }

          if (pendingCreateDraft.step === "priority") {
            const mapWord: Record<string, number> = {
              one: 1,
              two: 2,
              three: 3,
              four: 4,
              five: 5,
            };
            const parsedNum = Number(text);
            const priority = Number.isFinite(parsedNum)
              ? Math.trunc(parsedNum)
              : mapWord[text.toLowerCase()] ?? 0;
            if (priority < 1 || priority > 5) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "Please choose a priority between 1 and 5.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }

            const title = pendingCreateDraft.title?.trim();
            const dueAt = pendingCreateDraft.dueAt;
            if (!title || !dueAt) {
              setPendingCreateDraft(null);
              setPendingDisambig(null);
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "I lost context for this draft. Please say 'create reminder' again.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }

            const res = await fetch("/api/reminders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title,
                dueAt: new Date(dueAt).getTime(),
                recurrence: "none",
                priority,
                linkedTaskId: pendingCreateDraft.linkedTaskId || undefined,
              }),
            });
            if (!res.ok) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "I couldn’t create the reminder. Please try once more.",
                  createdAt: new Date().toISOString(),
                },
              ]);
              return;
            }
            await refreshReminders();
            playReminderSuccessAnimation();
            setPendingCreateDraft(null);
            setPendingDisambig(null);
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Done — reminder created for ${new Date(dueAt).toLocaleString()}.`,
                createdAt: new Date().toISOString(),
              },
            ]);
            return;
          }
        }

        if (
          /^\s*create(\s+a)?\s+reminder\b/i.test(messageText) &&
          !hasInlineCreateDetails(messageText)
        ) {
          const extractedTitle =
            extractCreateTitle(messageText) || DEFAULT_CHAT_REMINDER_TITLE;
          setPendingCreateDraft({ step: "date", title: extractedTitle });
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "Step 1/4: What date should I set? (today / tomorrow / YYYY-MM-DD)",
              createdAt: new Date().toISOString(),
            },
          ]);
          return;
        }

        const pendingActionSnapshot = pendingConfirmAction
          ?? (pendingTimeSuggestion
            ? {
                type: "create_reminder" as const,
                title: pendingTimeSuggestion.title,
                // Server reads body.pendingAction.dueAt — map suggestedDueAt → dueAt
                dueAt: pendingTimeSuggestion.suggestedDueAt,
                priority: pendingTimeSuggestion.priority,
                domain: pendingTimeSuggestion.domain,
                recurrence: pendingTimeSuggestion.recurrence,
              }
            : null);
        setPendingConfirmAction(null);
        setPendingTimeSuggestion(null);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: messageText,
            reminders,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              notes: t.notes,
              dueAt: t.dueAt,
              status: t.status,
              priority: t.priority,
              domain: t.domain,
            })),
            ...clientTimeZonePayload(),
            ...(responseReplyPayload ? { replyContext: responseReplyPayload } : {}),
            ...(pendingActionSnapshot ? { pendingAction: pendingActionSnapshot } : {}),
            ...(recentListedIds.length > 0 ? { recentListedIds } : {}),
          }),
        });

        const data = (await response.json()) as AgentResponse;
        applyAction(data.action);

        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.reply || "Done.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch {
        const grounded = tryGroundedReminderAnswer(
          messageText,
          reminders,
          new Date(),
          clientTimeZonePayload(),
        );
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              grounded ??
              "I could not reach the assistant. Check your connection and try again.",
            createdAt: new Date().toISOString(),
          },
        ]);
      } finally {
        setIsLoading(false);
      }
    };

    if (editingMessageId) {
      const editedAt = new Date().toISOString();
      const editingMessage = messagesRef.current.find(
        (m) => m.id === editingMessageId,
      );
      const replyFromEditedMessage = editingMessage?.meta?.replyTo
        ? {
            id: editingMessage.meta.replyTo.id,
            content: editingMessage.meta.replyTo.content,
            role: editingMessage.meta.replyTo.role,
          }
        : undefined;

      const nextMessages = (() => {
        const index = messagesRef.current.findIndex(
          (m) => m.id === editingMessageId,
        );
        if (index === -1) return messagesRef.current;
        return messagesRef.current.slice(0, index + 1).map((m) =>
          m.id === editingMessageId && m.role === "user"
            ? {
                ...m,
                content: prompt,
                meta: { ...(m.meta ?? {}), editedAt },
              }
            : m,
        );
      })();

      setMessages(nextMessages);
      setInput("");
      setEditingMessageId(null);
      setReplyTarget(null);
      chatPinnedToBottomRef.current = true;
      setIsLoading(true);
      setLoadingTextIndex(0);
      void dispatchAssistantResponse(prompt, replyFromEditedMessage, nextMessages);
      return;
    }

    if (briefingStreaming) return;

    chatPinnedToBottomRef.current = true;

    const replySnapshot = replyTarget;
    const replyPayload = toReplyContextPayload(replySnapshot);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
      ...(replySnapshot
        ? {
            meta: {
              replyTo: {
                id: replySnapshot.id,
                content: replySnapshot.content,
                role: replySnapshot.role,
              },
            },
          }
        : {}),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setReplyTarget(null);
    setIsLoading(true);
    setLoadingTextIndex(0);
    void dispatchAssistantResponse(prompt, replyPayload, messagesRef.current);
  };

  const getMinDate = () => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  };

  const resetReminderForm = useCallback(() => {
    const localNow = currentDateTimeLocalValue();
    setNewTitle("");
    setNewDate(localNow.slice(0, 10));
    setNewTime(localNow.slice(11, 16));
    setNewRecurrence("none");
    setNewNotes("");
    setEditingReminderId(null);
    setReminderStars(3);
    setReminderLinkedTaskId("");
    setReminderDomain("");
  }, []);

  const resetTaskForm = useCallback(() => {
    setTaskFormTitle("");
    setTaskFormDue(currentDateTimeLocalValue());
    setTaskFormNotes("");
    setTaskStars(3);
    setEditingTaskId(null);
    setTaskFormError(null);
    setTaskFormDomain("");
    setTaskDueUserEdited(false);
  }, []);
  resetTaskFormRef.current = resetTaskForm;

  const handleJsonImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = importJson.trim();
    if (!payload || isImporting) return;

    setIsImporting(true);
    setImportStatus(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        setImportStatus(
          "Invalid JSON. Please paste a valid JSON object or array.",
        );
        return;
      }

      const response = await fetch("/api/reminders/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = (await response.json()) as {
        error?: string;
        createdCount?: number;
        createdReminderCount?: number;
        createdTaskCount?: number;
      };
      if (!response.ok) {
        setImportStatus(data.error ?? "Import failed.");
        return;
      }

      const reminderCount = data.createdReminderCount ?? data.createdCount ?? 0;
      const taskCount = data.createdTaskCount ?? 0;
      setImportStatus(
        `Imported ${reminderCount} reminder${reminderCount === 1 ? "" : "s"} and ${taskCount} task${taskCount === 1 ? "" : "s"}.`,
      );
      await refreshReminders();
      await refreshTasks();
      setImportJson("");
    } catch {
      setImportStatus("Import failed. Please try again.");
    } finally {
      setIsImporting(false);
    }
  };

  const handleClearChat = async () => {
    if (isClearingChat) return;
    setIsClearingChat(true);
    try {
      const del = await fetch("/api/chat/history", { method: "DELETE" });
      if (!del.ok) {
        return;
      }
      clearChatBackup(userId);
      // Extend suppress window to 60s so in-flight polls from other tabs don't restore cleared history
      skipRemotePollMergeUntilRef.current = Date.now() + 60_000;
      setPendingCreateDraft(null);
      setPendingDisambig(null);
      setPendingConfirmAction(null);
      setPendingTimeSuggestion(null);
      setRecentListedIds([]);
      setReplyTarget(null);
      setEditingMessageId(null);
      const starter: ChatMessage = {
        ...STARTER_MESSAGE,
        createdAt: new Date().toISOString(),
      };
      setMessages([starter]);
      // Persist fresh thread on server so refresh and other tabs see the new baseline, not old history.
      await fetch("/api/chat/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              id: starter.id,
              role: starter.role,
              content: starter.content,
              createdAt: starter.createdAt,
            },
          ],
        }),
      });
    } finally {
      setIsClearingChat(false);
    }
  };

  const resolveDueLine = (messageId: string, line: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, meta: undefined, content: line } : m,
      ),
    );
  };

  const resolveDueReminderById = (reminderId: string, line: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.meta?.kind === "due_reminder" && m.meta.reminderId === reminderId
          ? { ...m, meta: undefined, content: line }
          : m,
      ),
    );
  };

  const handleDueReminderAction = async (
    messageId: string,
    reminderId: string,
    action: "delete" | "done" | "snooze" | "reschedule",
  ) => {
    const title =
      reminders.find((x) => x.id === reminderId)?.title ?? "Reminder";
    try {
      if (action === "delete") {
        await runReminderQuickAction(reminderId, "delete");
        resolveDueLine(messageId, `Deleted "${title}".`);
        resolveDueReminderById(reminderId, `Deleted "${title}".`);
        return;
      }
      if (action === "done") {
        await runReminderQuickAction(reminderId, "done");
        resolveDueLine(messageId, `Marked "${title}" as done.`);
        resolveDueReminderById(reminderId, `Marked "${title}" as done.`);
        return;
      }
      if (action === "snooze") {
        await runReminderQuickAction(reminderId, "snooze");
        resolveDueLine(messageId, `Snoozed "${title}" by one hour.`);
        resolveDueReminderById(reminderId, `Snoozed "${title}" by one hour.`);
        return;
      }
      const reminder = reminders.find((x) => x.id === reminderId);
      setRescheduleReminder({
        messageId,
        reminderId,
        title,
        value: toDateTimeLocalValue(reminder?.dueAt ?? new Date().toISOString()) || currentDateTimeLocalValue(),
        error: null,
      });
    } catch {
      resolveDueLine(messageId, `Something went wrong updating "${title}".`);
      resolveDueReminderById(
        reminderId,
        `Something went wrong updating "${title}".`,
      );
    }
  };

  const handleExportChat = () => {
    if (messages.length === 0) return;
    const lines = messages.map((message) => {
      const date = new Date(message.createdAt);
      const timestamp = date.toLocaleString();
      const sender =
        message.role === "user"
          ? "You"
          : message.role === "system"
            ? "Notice"
            : "RemindOS (System)";
      return `[${timestamp}] ${sender}: ${message.content}`;
    });
    const content = lines.join("\n\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;
    anchor.href = url;
    anchor.download = `remindos-chat-${stamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const commitRescheduleReminder = useCallback(async () => {
    if (!rescheduleReminder) return;
    const dueMs = Date.parse(rescheduleReminder.value);
    if (!Number.isFinite(dueMs)) {
      setRescheduleReminder((prev) =>
        prev ? { ...prev, error: "Choose a valid date and time." } : prev,
      );
      return;
    }
    if (dueMs <= Date.now()) {
      setRescheduleReminder((prev) =>
        prev ? { ...prev, error: "Choose a future date and time." } : prev,
      );
      return;
    }

    const { messageId, reminderId, title } = rescheduleReminder;
    try {
      await refreshAfterReminderMutation(
        fetch(`/api/reminders/${reminderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dueAt: dueMs }),
        }),
      );
      resolveDueLine(
        messageId,
        `Rescheduled "${title}" to ${new Date(dueMs).toLocaleString()}.`,
      );
      resolveDueReminderById(
        reminderId,
        `Rescheduled "${title}" to ${new Date(dueMs).toLocaleString()}.`,
      );
      setRescheduleReminder(null);
    } catch {
      showShareToast("Could not reschedule reminder. Try again.");
    }
  }, [refreshAfterReminderMutation, rescheduleReminder, showShareToast]);

  const parseBatchQuestions = (payload: unknown): string[] => {
    if (Array.isArray(payload)) {
      return payload
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }

    if (!payload || typeof payload !== "object") return [];
    const obj = payload as {
      questions?: unknown;
      items?: unknown;
      prompts?: unknown;
    };
    const candidate = obj.questions ?? obj.items ?? obj.prompts;
    if (!Array.isArray(candidate)) return [];
    return candidate
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  };

  const BATCH_MAX_QUESTIONS_PER_MINUTE = 30;
  const BATCH_MIN_INTERVAL_MS = Math.ceil(
    60_000 / BATCH_MAX_QUESTIONS_PER_MINUTE,
  );

  const waitFor = (durationMs: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, durationMs);
    });

  const handleBatchQuestions = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = batchJson.trim();
    if (!raw || isBatchRunning) return;

    setIsBatchRunning(true);
    setBatchStatus(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        setBatchStatus(
          "Invalid JSON. Please paste a valid JSON object or array.",
        );
        return;
      }

      const questions = parseBatchQuestions(parsed);
      if (questions.length === 0) {
        setBatchStatus(
          "No valid questions found. Use an array or { questions: [...] }.",
        );
        return;
      }

      let processed = 0;
      let nextAllowedSendAt = Date.now();
      for (const [index, question] of questions.entries()) {
        const now = Date.now();
        if (now < nextAllowedSendAt) {
          const waitMs = nextAllowedSendAt - now;
          setBatchStatus(
            `Waiting ${Math.ceil(waitMs / 1000)}s before sending ${index + 1}/${questions.length}...`,
          );
          await waitFor(waitMs);
        }

        const sentAt = Date.now();
        const userMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "user",
          content: question,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMessage]);
        setBatchStatus(
          `Processing ${processed + 1}/${questions.length} (one at a time)...`,
        );

        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: question,
              reminders: remindersRef.current,
              tasks: tasksRef.current.map((t) => ({
                id: t.id,
                title: t.title,
                notes: t.notes,
                dueAt: t.dueAt,
                status: t.status,
                priority: t.priority,
                domain: t.domain,
              })),
              ...clientTimeZonePayload(),
            }),
          });
          const data = (await response.json()) as AgentResponse;
          applyAction(data.action);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: data.reply || "Done.",
              createdAt: new Date().toISOString(),
            },
          ]);
        } catch {
          const grounded = tryGroundedReminderAnswer(
            question,
            remindersRef.current,
            new Date(),
            clientTimeZonePayload(),
          );
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content:
                grounded ??
                "I could not process this item right now. Continuing with next question.",
              createdAt: new Date().toISOString(),
            },
          ]);
        }

        processed += 1;
        nextAllowedSendAt = sentAt + BATCH_MIN_INTERVAL_MS;
      }

      setBatchStatus(`Completed ${processed}/${questions.length} questions.`);
      setBatchJson("");
    } finally {
      setIsBatchRunning(false);
    }
  };

  const openCreateModal = useCallback(
    (opts?: { linkedTaskId?: string }) => {
      resetReminderForm();
      setCreateFormError(null);
      setShowReminderInlineTask(false);
      setReminderInlineTaskTitle("");
      setReminderInlineTaskDue("");
      setIsCreateOpen(true);
      if (opts?.linkedTaskId) {
        setReminderLinkedTaskId(opts.linkedTaskId);
      }
    },
    [resetReminderForm],
  );

  const openTasksPanel = useCallback(
    (
      mode: "create" | "browse" = "browse",
      preserveState = false,
      initialTab?: "missed" | "pending" | "done" | "all",
    ) => {
      if (!preserveState) {
        resetTaskForm();
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
    [refreshTasks, resetTaskForm, tasksGrouped],
  );

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

  useEffect(() => {
    if (!userId || !user) return;
    if (typeof window === "undefined") return;
    if (walkthroughLoadingRef.current) return;
    walkthroughLoadingRef.current = true;

    const storageKey = walkthroughStorageKey(userId);
    const createdAt = Number(user.createdAt ?? 0);
    const eligible = Number.isFinite(createdAt) && createdAt >= WALKTHROUGH_RELEASE_AT;

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

  const pushDashboardOverlay = useCallback((state: DashboardOverlayState) => {
    if (typeof window === "undefined") return;
    const hasExistingOverlay = Boolean(
      (
        window.history.state as {
          dashboardOverlay?: DashboardOverlayState;
        } | null
      )?.dashboardOverlay?.overlay,
    );
    const nextState = {
      ...(window.history.state && typeof window.history.state === "object"
        ? window.history.state
        : {}),
      dashboardOverlay: state,
    };
    if (hasExistingOverlay) {
      window.history.replaceState(nextState, "", window.location.href);
    } else {
      window.history.pushState(nextState, "", window.location.href);
    }
  }, []);

  const dismissDashboardOverlay = useCallback(
    (overlay: DashboardOverlay, fallback: () => void) => {
      const current = readDashboardOverlayFromHistory();
      if (current?.overlay === overlay && typeof window !== "undefined") {
        window.history.back();
        fallback();
        return;
      }
      fallback();
    },
    [readDashboardOverlayFromHistory],
  );

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
      setReminderListTab(tab);
      setIsListOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "reminders" });
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
      setImportStatus(null);
      setIsImportOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "import" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const showBatchOverlay = useCallback(
    (pushHistory = true) => {
      closeAllDashboardOverlays();
      setBatchStatus(null);
      setIsBatchOpen(true);
      if (pushHistory) pushDashboardOverlay({ overlay: "batch" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const markWalkthroughComplete = useCallback(async () => {
    if (!userId || typeof window === "undefined") {
      setWalkthroughOpen(false);
      setWalkthroughStepIndex(0);
      return;
    }

    try {
      await fetch("/api/onboarding/walkthrough", {
        method: "POST",
      });
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
    if (!walkthroughOpen) return;
    closeAllDashboardOverlays();
  }, [walkthroughOpen, walkthroughStepIndex, closeAllDashboardOverlays]);

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

  const closeSnapshotOverlay = useCallback(
    () => dismissDashboardOverlay("snapshot", () => setIsSnapshotOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeReminderListOverlay = useCallback(
    () => dismissDashboardOverlay("reminders", () => setIsListOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeCreateOverlay = useCallback(
    () => dismissDashboardOverlay("create", () => setIsCreateOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeTasksOverlay = useCallback(
    () => dismissDashboardOverlay("tasks", () => setIsTasksOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeShareOverlay = useCallback(
    () => dismissDashboardOverlay("share", () => setIsShareOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeImportOverlay = useCallback(
    () => dismissDashboardOverlay("import", () => setIsImportOpen(false)),
    [dismissDashboardOverlay],
  );
  const closeBatchOverlay = useCallback(
    () => dismissDashboardOverlay("batch", () => setIsBatchOpen(false)),
    [dismissDashboardOverlay],
  );

  useEffect(() => {
    const openCreate = () => showCreateOverlay(undefined);
    window.addEventListener("dashboard:create-reminder", openCreate);
    return () =>
      window.removeEventListener("dashboard:create-reminder", openCreate);
  }, [showCreateOverlay]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const state =
        (event.state as { dashboardOverlay?: DashboardOverlayState } | null)
          ?.dashboardOverlay ?? null;
      if (!state?.overlay) {
        closeAllDashboardOverlays();
        return;
      }
      switch (state.overlay) {
        case "snapshot":
          showSnapshotOverlay(false);
          break;
        case "reminders":
          showReminderListOverlay(false);
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

  const openCreateReminderFromRemindersList = () => {
    showCreateOverlay();
  };

  const openCreateTaskFromRemindersList = () => {
    showTasksOverlay("create");
  };

  const openAllTasksFromSnapshot = () => {
    showTasksOverlay("browse", true, false, "all");
  };

  const openNextTwoHoursFromSnapshot = () => {
    showReminderListOverlay(true, "next2hours");
  };

  const openReminderListFromCreateModal = () => {
    showReminderListOverlay();
  };

  const openReminderListFromTasksPanel = () => {
    showReminderListOverlay(true, "all");
  };

  const openLinkedReminderForTask = useCallback(
    (task: TaskRow) => {
      showCreateOverlay({ linkedTaskId: task.id });
    },
    [showCreateOverlay],
  );

  useEffect(() => {
    const openR = () => showReminderListOverlay();
    const openT = () => showTasksOverlay("browse", true, false, "all");
    const runB = () => runBriefingStream();
    const clearChat = () => {
      void handleClearChat();
    };
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
      window.removeEventListener("dashboard:open-next-two-hours", openNext2h);
    };
  }, [showTasksOverlay, showImportOverlay, showBatchOverlay, handleExportChat, openNextTwoHoursFromSnapshot]);

  useEffect(() => {
    const o = searchParams?.get("open");
    if (o !== "reminders" && o !== "tasks" && o !== "create") return;
    if (typeof window !== "undefined") {
      const nextState =
        window.history.state && typeof window.history.state === "object"
          ? { ...window.history.state }
          : {};
      delete (nextState as { dashboardOverlay?: DashboardOverlayState })
        .dashboardOverlay;
      window.history.replaceState(nextState, "", "/dashboard");
    }
    if (o === "reminders") showReminderListOverlay();
    if (o === "tasks") showTasksOverlay("browse", true, false, "all");
    if (o === "create") showCreateOverlay();
  }, [
    searchParams,
    showCreateOverlay,
    showReminderListOverlay,
    showTasksOverlay,
  ]);

  const openEditModal = useCallback(
    (reminder: ReminderItem) => {
      closeAllDashboardOverlays();
      setCreateFormError(null);
      setShowReminderInlineTask(false);
      setReminderInlineTaskTitle("");
      setReminderInlineTaskDue("");
      const dueDate = new Date(reminder.dueAt);
      // Use the user's local timezone consistently for both date and time parts
      // (toISOString is UTC, toTimeString is browser-local — mixing them causes wrong values)
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: localTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(dueDate);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
      const datePart = `${get("year")}-${get("month")}-${get("day")}`;
      const timePart = `${get("hour").replace("24", "00")}:${get("minute")}`;
      setEditingReminderId(reminder.id);
      setNewTitle(reminder.title);
      setNewDate(datePart);
      setNewTime(timePart);
      setNewRecurrence(reminder.recurrence ?? "none");
      setNewNotes(reminder.notes ?? "");
      setReminderStars(
        typeof reminder.priority === "number" &&
          reminder.priority >= 1 &&
          reminder.priority <= 5
          ? reminder.priority
          : 0,
      );
      setReminderLinkedTaskId(reminder.linkedTaskId ?? "");
      setReminderDomain(reminder.domain ?? "");
      setIsCreateOpen(true);
      pushDashboardOverlay({ overlay: "create" });
    },
    [closeAllDashboardOverlays, pushDashboardOverlay],
  );

  const openTaskReminderReschedule = useCallback(
    (reminder: ReminderItem) => {
      setRescheduleReminder({
        messageId: `task-view:${reminder.id}`,
        reminderId: reminder.id,
        title: reminder.title,
        value:
          toDateTimeLocalValue(reminder.dueAt) || currentDateTimeLocalValue(),
        error: null,
      });
    },
    [],
  );

  const handleTaskReminderAction = useCallback(
    (reminder: ReminderItem, action: "done" | "delete") => {
      void runReminderQuickAction(reminder.id, action).catch(() => {
        showShareToast("Could not update reminder. Try again.");
      });
    },
    [runReminderQuickAction, showShareToast],
  );

  const handleManualCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newTitle.trim()) {
      const message = "Title is required.";
      setCreateFormError(message);
      showShareToast(message);
      return;
    }
    if (!newDate) {
      const message = "Date is required.";
      setCreateFormError(message);
      showShareToast(message);
      return;
    }
    if (!newTime) {
      const message = "Time is required.";
      setCreateFormError(message);
      showShareToast(message);
      return;
    }
    if (reminderStars < 1 || reminderStars > 5) {
      const message = "Choose a priority: tap 1–5 stars.";
      setCreateFormError(message);
      showShareToast(message);
      return;
    }
    setCreateFormError(null);
    const dueAt = new Date(`${newDate}T${newTime}`).toISOString();
    const dueAtMs = new Date(dueAt).getTime();
    if (!Number.isFinite(dueAtMs)) {
      setCreateFormError("Invalid date or time.");
      return;
    }
    if (dueAtMs <= Date.now()) {
      setCreateFormError("Date and time must be in the future.");
      return;
    }

    if (editingReminderId) {
      try {
        const canLink =
          reminders.find((r) => r.id === editingReminderId)?.access !==
          "shared";
        const linkPayload: Record<string, unknown> = {};
        if (canLink) {
          linkPayload.linkedTaskId = reminderLinkedTaskId.trim() || null;
          linkPayload.domain = reminderDomain || null;
        }
        const res = await fetch(`/api/reminders/${editingReminderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: newTitle.trim(),
            dueAt: dueAtMs,
            recurrence: newRecurrence,
            notes: newNotes.trim() ? newNotes.trim() : undefined,
            priority: reminderStars,
            ...linkPayload,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setCreateFormError(data.error ?? "Could not update reminder.");
          return;
        }
        await refreshReminders();
      } catch {
        setCreateFormError("Network error. Try again.");
        return;
      }
    } else {
      const isDuplicate = reminders.some(
        (item) =>
          item.status === "pending" &&
          item.title.trim().toLowerCase() === newTitle.trim().toLowerCase() &&
          new Date(item.dueAt).getTime() === dueAtMs,
      );
      if (isDuplicate) {
        resetReminderForm();
        closeCreateOverlay();
        return;
      }

      try {
        const createBody: Record<string, unknown> = {
          title: newTitle.trim(),
          dueAt: dueAtMs,
          recurrence: newRecurrence,
          notes: newNotes.trim() ? newNotes.trim() : undefined,
          priority: reminderStars,
        };
        if (reminderLinkedTaskId.trim()) {
          createBody.linkedTaskId = reminderLinkedTaskId.trim();
        }
        if (reminderDomain) {
          createBody.domain = reminderDomain;
        }
        const res = await fetch("/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createBody),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          created?: boolean;
        };
        if (!res.ok) {
          setCreateFormError(data.error ?? "Could not save reminder.");
          return;
        }
        await refreshReminders();
        playReminderSuccessAnimation({
          title: newTitle.trim(),
          time: new Date(`${newDate}T${newTime}`).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        });
        resetReminderForm();
        setCreateFormError(null);
        closeCreateOverlay();
        if (data.created === false) return;
        return;
      } catch {
        setCreateFormError("Network error. Try again.");
        return;
      }
    }
    resetReminderForm();
    setCreateFormError(null);
    closeCreateOverlay();
  };

  const persistDueNotifPrefs = useCallback(
    (patch: Partial<DueNotificationPrefs>) => {
      setDueNotifPrefs((prev) => {
        const next = { ...prev, ...patch };
        saveDueNotificationPrefs(next);
        return next;
      });
    },
    [],
  );

  const requestDueNotificationPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    setNotifUiTick((t) => t + 1);
    if (p === "granted") {
      persistDueNotifPrefs({ enabled: true });
    }
  }, [persistDueNotifPrefs]);

  /** Only lock during session briefing stream — avoid clashing typewriter placeholder + caret. */
  const briefingComposerLocked = briefingStreaming && !editingMessageId;

  const dismissDueNotifBanner = useCallback(() => {
    try {
      sessionStorage.setItem("remindos:dueNotifBannerDismissed", "1");
    } catch {
      /* ignore */
    }
    setDueNotifBannerDismissed(true);
  }, []);

  const openTaskEdit = (task: TaskRow) => {
    setTaskMode("create");
    setEditingTaskId(task.id);
    setTaskFormTitle(task.title);
    setTaskFormNotes(task.notes ?? "");
    setTaskFormDue(toDateTimeLocalValue(task.dueAt));
    setTaskDueUserEdited(true);
    setTaskStars(
      typeof task.priority === "number" &&
        task.priority >= 1 &&
        task.priority <= 5
        ? task.priority
        : 0,
    );
    setTaskFormDomain(task.domain ?? "");
    setTaskFormError(null);
    setIsTasksOpen(true);
  };

  const handleTaskSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!taskFormTitle.trim()) {
      const message = "Task title is required.";
      setTaskFormError(message);
      showShareToast(message);
      return;
    }
    if (taskStars < 1 || taskStars > 5) {
      const message = "Choose a priority: tap 1–5 stars.";
      setTaskFormError(message);
      showShareToast(message);
      return;
    }
    setTaskFormError(null);
    let dueAt: number | undefined;
    if (taskFormDue.trim()) {
      const ms = new Date(taskFormDue).getTime();
      if (!Number.isFinite(ms)) {
        setTaskFormError("Invalid date or time.");
        return;
      }
      dueAt = ms;
    }
    try {
      const payload: Record<string, unknown> = {
        title: taskFormTitle.trim(),
        notes: taskFormNotes.trim() ? taskFormNotes.trim() : undefined,
        dueAt,
        priority: taskStars,
      };
      if (editingTaskId) {
        payload.domain = taskFormDomain || null;
      } else if (taskFormDomain) {
        payload.domain = taskFormDomain;
      }
      const res = editingTaskId
        ? await fetch(`/api/tasks/${editingTaskId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setTaskFormError(data.error ?? "Could not save task.");
        return;
      }
      resetTaskForm();
      await refreshTasks();
    } catch {
      setTaskFormError("Network error. Try again.");
    }
  };

  useEffect(() => {
    if (!isTasksOpen || editingTaskId || taskDueUserEdited) return;
    const tick = () => setTaskFormDue(currentDateTimeLocalValue());
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [isTasksOpen, editingTaskId, taskDueUserEdited]);

  useEffect(() => {
    if (showReminderInlineTask) {
      setReminderInlineTaskDue(currentDateTimeLocalValue());
    }
  }, [showReminderInlineTask]);

  const createReminderInlineTask = useCallback(async () => {
    const title = reminderInlineTaskTitle.trim();
    if (!title) {
      setCreateFormError("Enter a name for the new task.");
      return;
    }
    setReminderInlineTaskSaving(true);
    setCreateFormError(null);
    try {
      let dueAt: number | undefined;
      if (reminderInlineTaskDue.trim()) {
        const ms = new Date(reminderInlineTaskDue).getTime();
        if (Number.isFinite(ms)) dueAt = ms;
      }
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          priority: 3,
          dueAt,
          status: "pending",
        }),
      });
      const data = (await res.json()) as {
        task?: { _id?: string };
        error?: string;
      };
      if (!res.ok) {
        setCreateFormError(data.error ?? "Could not create task.");
        return;
      }
      const tid = data.task?._id;
      if (tid) {
        setReminderLinkedTaskId(String(tid));
        await refreshTasks();
        setShowReminderInlineTask(false);
        setReminderInlineTaskTitle("");
        setReminderInlineTaskDue("");
      }
    } catch {
      setCreateFormError("Network error creating task.");
    } finally {
      setReminderInlineTaskSaving(false);
    }
  }, [reminderInlineTaskTitle, reminderInlineTaskDue, refreshTasks]);

  const startReminderForCurrentTask = useCallback(async () => {
    if (!taskFormTitle.trim()) {
      setTaskFormError("Add a task title first.");
      return;
    }
    if (taskStars < 1 || taskStars > 5) {
      setTaskFormError("Choose priority: tap 1–5 stars.");
      return;
    }
    setTaskFormError(null);
    let dueAt: number | undefined;
    if (taskFormDue.trim()) {
      const ms = new Date(taskFormDue).getTime();
      if (!Number.isFinite(ms)) {
        setTaskFormError("Invalid due date or time.");
        return;
      }
      dueAt = ms;
    }
    try {
      let taskId = editingTaskId;
      if (!taskId) {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: taskFormTitle.trim(),
            notes: taskFormNotes.trim() ? taskFormNotes.trim() : undefined,
            dueAt,
            priority: taskStars,
            status: "pending",
            ...(taskFormDomain ? { domain: taskFormDomain } : {}),
          }),
        });
        const data = (await res.json()) as {
          task?: { _id?: string };
          error?: string;
        };
        if (!res.ok) {
          setTaskFormError(data.error ?? "Could not save task.");
          return;
        }
        const tid = data.task?._id;
        if (!tid) {
          setTaskFormError("Task saved but missing id.");
          return;
        }
        taskId = String(tid);
        setEditingTaskId(taskId);
        await refreshTasks();
      }
      showCreateOverlay({ linkedTaskId: taskId });
    } catch {
      setTaskFormError("Network error. Try again.");
    }
  }, [
    editingTaskId,
    taskFormTitle,
    taskFormDue,
    taskFormNotes,
    taskStars,
    taskFormDomain,
    refreshTasks,
    showCreateOverlay,
  ]);

  return (
    <>
      <section className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-[#fafaf9]">
        <div className="flex min-h-0 w-full flex-1">
          {/* LEFT SIDEBAR — desktop only */}
          <aside className="hidden w-[220px] shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
            {/* Date */}
            <div className="border-b border-slate-100 px-4 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Today</p>
              <p className="mt-0.5 text-sm font-semibold text-slate-700">
                {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </p>
            </div>
            {/* New Reminder button */}
            <div className="px-3 py-3">
              <button
                type="button"
                onClick={() => showCreateOverlay({})}
                className="flex w-full items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500"
              >
                <span className="text-lg leading-none">+</span>
                New Reminder
              </button>
            </div>
            {/* Reminders section */}
            <div className="px-2 pb-2">
              <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Reminders</p>
              {(
                [
                  { key: "all" as ReminderListTab, label: "All", count: reminders.length, dot: "#64748b" },
                  { key: "missed" as ReminderListTab, label: "Missed", count: snapshot.missed, dot: "#f43f5e" },
                  { key: "today" as ReminderListTab, label: "Today", count: snapshot.today, dot: "#f59e0b" },
                  { key: "tomorrow" as ReminderListTab, label: "Tomorrow", count: snapshot.tomorrow, dot: "#7c3aed" },
                  { key: "upcoming" as ReminderListTab, label: "Later", count: grouped.upcoming.length, dot: "#06b6d4" },
                  { key: "done" as ReminderListTab, label: "Done", count: snapshot.done ?? 0, dot: "#10b981" },
                ] as { key: ReminderListTab; label: string; count: number; dot: string }[]
              ).map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setReminderListTabDesktop(b.key)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                    reminderListTabDesktop === b.key
                      ? "bg-violet-50 text-violet-700"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: b.dot }} />
                  <span className="flex-1 text-sm font-medium">{b.label}</span>
                  {b.count > 0 && (
                    <span className={`text-xs font-semibold ${reminderListTabDesktop === b.key ? "text-violet-600" : "text-slate-400"}`}>
                      {b.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="mx-3 h-px bg-slate-100" />
            {/* Tasks section */}
            <div className="px-2 py-2">
              <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tasks</p>
              <button
                type="button"
                onClick={openAllTasksFromSnapshot}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-700 transition hover:bg-slate-50"
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full bg-indigo-500" />
                <span className="flex-1 text-sm font-medium">Upcoming</span>
              </button>
              <button
                type="button"
                onClick={openAllTasksFromSnapshot}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-700 transition hover:bg-slate-50"
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500" />
                <span className="flex-1 text-sm font-medium">Done</span>
              </button>
            </div>
            <div className="mx-3 h-px bg-slate-100" />
            {/* Shared */}
            <div className="px-2 py-2">
              <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Collaboration</p>
              <button
                type="button"
                onClick={() => setReminderListTabDesktop("shared")}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-700 transition hover:bg-slate-50"
              >
                <span className="h-2 w-2 flex-shrink-0 rounded-full bg-cyan-500" />
                <span className="flex-1 text-sm font-medium">Shared with me</span>
                {shareInbox.length > 0 && (
                  <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
                    {shareInbox.length}
                  </span>
                )}
              </button>
            </div>
            <div className="flex-1" />
            {/* Bottom actions */}
            <div className="border-t border-slate-100 px-2 py-2">
              <button
                type="button"
                onClick={() => runBriefingStream()}
                disabled={!isHistoryLoaded || briefingStreaming || isLoading}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
              >
                <span className="text-sm">✦</span>
                <span className="text-sm font-medium">Run Briefing</span>
              </button>
              <div className="mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2">
                <NotificationBell pollIntervalMs={30_000} />
              </div>
            </div>
          </aside>

          {/* MAIN CONTENT — desktop only inline reminders */}
          <div className="hidden min-h-0 flex-1 flex-col bg-[#fafaf9] lg:flex">
            {/* Panel header */}
            <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
              <h2 className="flex-1 text-base font-bold text-slate-900">Reminders</h2>
              <button
                type="button"
                onClick={() => showCreateOverlay({})}
                className="rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
              >
                + New Reminder
              </button>
              <button
                type="button"
                onClick={openAllTasksFromSnapshot}
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                + Task
              </button>
            </div>
            {/* Bucket tabs */}
            <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2.5 scrollbar-none">
              {(
                [
                  { key: "all", label: "All", count: reminders.length, activeClass: "bg-slate-700 text-white", inactiveClass: "bg-slate-100 text-slate-700 border border-slate-200" },
                  { key: "missed", label: "Missed", count: snapshot.missed, activeClass: "bg-rose-600 text-white", inactiveClass: "bg-rose-50 text-rose-700 border border-rose-200" },
                  { key: "today", label: "Today", count: snapshot.today, activeClass: "bg-amber-500 text-white", inactiveClass: "bg-amber-50 text-amber-700 border border-amber-200" },
                  { key: "tomorrow", label: "Tomorrow", count: snapshot.tomorrow, activeClass: "bg-violet-600 text-white", inactiveClass: "bg-violet-50 text-violet-700 border border-violet-200" },
                  { key: "upcoming", label: "Later", count: grouped.upcoming.length, activeClass: "bg-cyan-600 text-white", inactiveClass: "bg-cyan-50 text-cyan-700 border border-cyan-200" },
                  { key: "shared", label: "Shared", count: shareInbox.length, activeClass: "bg-cyan-600 text-white", inactiveClass: "bg-slate-100 text-slate-600 border border-slate-200" },
                  { key: "done", label: "Done", count: snapshot.done ?? 0, activeClass: "bg-emerald-600 text-white", inactiveClass: "bg-slate-100 text-slate-600 border border-slate-200" },
                ] as { key: ReminderListTab; label: string; count: number; activeClass: string; inactiveClass: string }[]
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setReminderListTabDesktop(tab.key)}
                  className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
                    reminderListTabDesktop === tab.key ? tab.activeClass : tab.inactiveClass
                  }`}
                >
                  {tab.label}{tab.count > 0 ? ` (${tab.count})` : ""}
                </button>
              ))}
            </div>
            {/* ── Desktop search bar ── */}
            {reminderListTabDesktop !== "shared" && (
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-4 py-2">
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input
                    value={reminderSearchQuery}
                    onChange={(e) => setReminderSearchQuery(e.target.value)}
                    placeholder="Search reminders…"
                    className="flex-1 bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400"
                  />
                  {reminderSearchQuery && (
                    <button type="button" onClick={() => setReminderSearchQuery("")} className="text-slate-400 hover:text-slate-600">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-3 w-3"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Missed banner */}
            {snapshot.missed > 0 && (
              <div className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                <span className="flex-1 text-xs font-semibold text-rose-800">
                  {snapshot.missed} overdue reminder{snapshot.missed > 1 ? "s" : ""} need attention
                </span>
                <button
                  type="button"
                  onClick={() => setReminderListTabDesktop("missed")}
                  className="rounded-full bg-rose-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-rose-500"
                >
                  View
                </button>
              </div>
            )}
            {/* Reminders list */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-none">
              <div className="grid gap-3">
                {(() => {
                  const desktopRowsRaw =
                    reminderListTabDesktop === "shared"
                      ? grouped.missed /* placeholder — share inbox shown below */
                      : reminderListTabDesktop === "done"
                      ? grouped.done
                      : reminderListTabDesktop === "upcoming"
                      ? grouped.upcoming
                      : reminderListTabDesktop === "missed"
                      ? grouped.missed
                      : reminderListTabDesktop === "today"
                      ? grouped.today
                      : reminderListTabDesktop === "tomorrow"
                      ? grouped.tomorrow
                      : reminderListTabDesktop === "all"
                      ? reminders
                      : [];
                  const desktopRows = reminderListTabDesktop === "shared"
                    ? desktopRowsRaw
                    : desktopRowsRaw.filter((r) => matchesReminderSearch(r, reminderSearchQuery));

                  if (reminderListTabDesktop === "shared") {
                    return shareInbox.length === 0 ? (
                      <p className="py-8 text-center text-sm text-slate-400">No shared reminders.</p>
                    ) : (
                      groupShareInboxRows(shareInbox).map(({ batchKey, rows }) => {
                        const first = rows[0]!;
                        const n = rows.length;
                        return (
                          <div key={batchKey} className="rounded-xl border border-violet-200 bg-white px-4 py-3 shadow-sm">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-900">
                                  {first.fromDisplayName}
                                  {n > 1 ? ` · ${n} reminders` : ` · ${first.title}`}
                                </p>
                              </div>
                              <span className="flex shrink-0 gap-1">
                                <button
                                  type="button"
                                  className="rounded-full bg-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white"
                                  onClick={() => void joinShareBatch(batchKey)}
                                >
                                  Accept all
                                </button>
                                <button
                                  type="button"
                                  className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-semibold text-slate-700"
                                  onClick={() => void dismissShareBatch(batchKey)}
                                >
                                  Deny
                                </button>
                              </span>
                            </div>
                          </div>
                        );
                      })
                    );
                  }

                  if (desktopRows.length === 0) {
                    return <p className="py-8 text-center text-sm text-slate-400">Nothing here yet.</p>;
                  }

                  return desktopRows.map((reminder) => {
                    const bucket = reminderListTabDesktop;
                    return (
                      <article
                        key={reminder.id}
                        className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${
                          bucket === "missed"
                            ? "border-l-[3px] border-l-rose-500"
                            : bucket === "today"
                            ? "border-l-[3px] border-l-amber-500"
                            : bucket === "tomorrow"
                            ? "border-l-[3px] border-l-violet-500"
                            : bucket === "done"
                            ? "border-l-[3px] border-l-emerald-500"
                            : "border-l-[3px] border-l-cyan-500"
                        }`}
                      >
                        <div className="p-3">
                          <p className="font-semibold text-slate-900">{reminder.title}</p>
                          <p className="mt-0.5 text-xs text-slate-500">Due: {formatDisplayDateTime(reminder.dueAt)}</p>
                          {reminder.notes ? (
                            <p className="mt-1 text-xs text-slate-600">{reminder.notes}</p>
                          ) : null}
                          {reminder.status !== "done" && reminder.status !== "archived" ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  void refreshAfterReminderMutation(
                                    fetch(`/api/reminders/${reminder.id}`, {
                                      method: "PATCH",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ status: "done" }),
                                    }),
                                  );
                                }}
                                className="rounded-full bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold text-white"
                              >
                                Done
                              </button>
                              <button
                                type="button"
                                onClick={() => openEditModal(reminder)}
                                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-700"
                              >
                                Edit
                              </button>
                              {reminder.access !== "shared" ? (
                                <button
                                  type="button"
                                  onClick={() => showShareOverlay([reminder.id])}
                                  className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700"
                                >
                                  Share
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  });
                })()}
              </div>
            </div>
          </div>

          {/* MOBILE + DESKTOP CHAT — right panel on desktop, full screen on mobile */}
          <div className="flex min-h-0 w-full flex-1 flex-col lg:w-[320px] lg:flex-none lg:border-l lg:border-slate-200" style={{ background: "#1a1625" }}>
          <div className="flex min-h-0 flex-1 flex-col gap-0">
            {mounted &&
            typeof Notification !== "undefined" &&
            Notification.permission === "default" &&
            !dueNotifBannerDismissed ? (
              <div className="flex flex-col gap-2 rounded-none border-b border-violet-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm sm:rounded-[24px] sm:border lg:hidden">
                <p className="leading-snug text-slate-600">
                  Allow notifications to get an instant alert when a reminder is
                  due, then act from the alert with Done, Snooze, or Delete.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void requestDueNotificationPermission()}
                    className="rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
                  >
                    Allow alerts
                  </button>
                  <button
                    type="button"
                    onClick={dismissDueNotifBanner}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Not now
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ background: "#1a1625" }}>
              {/* ── Mobile top bar — greeting + compact stat pills in one slim row ──
                  The global header already has RemindOS brand + hamburger + bell,
                  so we only show a subtle greeting and non-zero reminder counts. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(255,255,255,0.07)] px-4 py-2 lg:hidden">
                {/* Greeting — small and unobtrusive */}
                <p className="flex-1 truncate text-xs font-medium text-[rgba(255,255,255,0.45)]">
                  {(() => {
                    const h = new Date().getHours();
                    const g = h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
                    const name = user?.firstName?.trim();
                    return name ? `Good ${g}, ${name} ${h < 18 ? "☀️" : "🌙"}` : `Good ${g}`;
                  })()}
                </p>
                {/* Compact stat pills — only render when count > 0 */}
                <div className="flex items-center gap-1.5">
                  {(
                    [
                      { count: snapshot.missed,         label: "Missed",  bg: "rgba(244,63,94,0.15)",  border: "rgba(244,63,94,0.35)",  text: "#fda4af", tab: "missed"   as const },
                      { count: snapshot.today,          label: "Today",   bg: "rgba(245,158,11,0.15)", border: "rgba(245,158,11,0.35)", text: "#fcd34d", tab: "today"    as const },
                      { count: snapshot.tomorrow,       label: "Tmr",     bg: "rgba(124,58,237,0.15)", border: "rgba(124,58,237,0.35)", text: "#c4b5fd", tab: "tomorrow" as const },
                      { count: grouped.upcoming.length, label: "Later",   bg: "rgba(6,182,212,0.15)",  border: "rgba(6,182,212,0.35)",  text: "#67e8f9", tab: "upcoming" as const },
                    ] as const
                  )
                    .filter((item) => item.count > 0)
                    .map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => showReminderListOverlay(true, item.tab)}
                        className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition active:scale-95"
                        style={{ background: item.bg, border: `1px solid ${item.border}`, color: item.text }}
                      >
                        <span className="font-bold">{item.count}</span>
                        <span className="opacity-80">{item.label}</span>
                      </button>
                    ))}
                </div>
              </div>

              {/* Inner toolbar — hidden on mobile, shown sm+ (desktop chat panel header) */}
              <div className="hidden shrink-0 items-center justify-end gap-2 border-b border-[rgba(255,255,255,0.08)] px-4 py-3 sm:flex sm:px-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={openNextTwoHoursFromSnapshot}
                    className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-amber-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
                  >
                    <span aria-hidden className="text-base">⏱</span>
                    Next 2 hrs
                  </button>
                  <button
                    type="button"
                    onClick={() => showReminderListOverlay()}
                    className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-slate-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
                  >
                    <span aria-hidden>☰</span>
                    Reminders
                  </button>
                  <button
                    type="button"
                    onClick={openAllTasksFromSnapshot}
                    data-walkthrough="all-tasks-trigger"
                    className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-teal-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
                  >
                    <span aria-hidden>≣</span>
                    Tasks
                  </button>
                  <button
                    type="button"
                    onClick={() => showSnapshotOverlay()}
                    className="hidden h-10 items-center justify-center gap-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 text-xs font-semibold text-slate-300 shadow-sm transition hover:bg-[rgba(255,255,255,0.12)] sm:inline-flex lg:hidden"
                  >
                    Menu
                  </button>
                </div>
                {/* Notification bell */}
                <NotificationBell pollIntervalMs={30_000} />

                <button
                  type="button"
                  onClick={() => runBriefingStream()}
                  data-walkthrough="briefing-trigger"
                  disabled={
                    !isHistoryLoaded || briefingStreaming || isLoading
                  }
                  className="inline-flex h-9 items-center justify-center rounded-full border border-violet-500/40 bg-violet-600/20 px-3 text-[11px] font-semibold text-violet-300 shadow-sm transition hover:bg-violet-600/30 disabled:cursor-not-allowed disabled:opacity-40 sm:h-10 sm:px-4 sm:text-xs"
                >
                  Briefing
                </button>
              </div>

              {/* Urgency strip — desktop only (mobile uses the 4-col grid above) */}
              {(snapshot.missed > 0 || snapshot.today > 0 || snapshot.tomorrow > 0) && (
                <div className="hidden shrink-0 items-center gap-2 overflow-x-auto border-b border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.04)] px-4 py-2 scrollbar-none lg:flex">
                  {snapshot.missed > 0 && (
                    <button type="button" onClick={() => showReminderListOverlay(true, "missed")}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />Overdue
                      <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] leading-none text-white">{snapshot.missed}</span>
                    </button>
                  )}
                  {snapshot.today > 0 && (
                    <button type="button" onClick={() => showReminderListOverlay(true, "today")}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Today
                      <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] leading-none text-white">{snapshot.today}</span>
                    </button>
                  )}
                  {snapshot.tomorrow > 0 && (
                    <button type="button" onClick={() => showReminderListOverlay(true, "tomorrow")}
                      className="flex shrink-0 items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-300 transition hover:bg-violet-500/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />Tomorrow
                      <span className="rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] leading-none text-white">{snapshot.tomorrow}</span>
                    </button>
                  )}
                </div>
              )}

              <div
                ref={chatScrollRef}
                onScroll={onChatScroll}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-y-contain bg-[#1a1625] px-4 py-5 scrollbar-none sm:px-6 sm:py-6"
              >
                <div className="mx-auto grid min-w-0 max-w-4xl gap-4">
                  {messages.map((message) => {
                    const startReplyTo = () => {
                      setReplyTarget(message);
                      setEditingMessageId(null);
                    };
                    const startEditUser = () => {
                      if (message.role !== "user") return;
                      setEditingMessageId(message.id);
                      setInput(message.content);
                      setReplyTarget(null);
                    };

                    if (message.role === "system") {
                      return (
                        <ChatBubbleShell
                          key={message.id}
                          onReply={startReplyTo}
                          showEdit={false}
                          actionAlign="center"
                          showActionsAlways
                          desktopHoverMenu
                        >
                          <div className="mx-auto min-w-0 max-w-[42rem] rounded-[24px] border border-amber-200 bg-amber-50 px-4 py-3 text-center text-xs text-amber-900 shadow-sm">
                            <StructuredMessage content={message.content} />
                            <p className="mt-1 text-[10px] text-amber-700/80">
                              {new Date(message.createdAt).toLocaleTimeString(
                                [],
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </p>
                          </div>
                        </ChatBubbleShell>
                      );
                    }
                    const dueMeta =
                      message.meta?.kind === "due_reminder"
                        ? message.meta
                        : null;
                    const dueReminder = dueMeta?.reminderId
                      ? reminders.find((r) => r.id === dueMeta.reminderId)
                      : null;
                    const dueReminderResolved =
                      !!dueMeta?.reminderId &&
                      (!dueReminder ||
                        dueReminder.status === "done" ||
                        dueReminder.status === "archived");
                    const replyQuote = message.meta?.replyTo;
                    const showUserEdit =
                      message.role === "user" && !dueMeta?.reminderId;
                    const bubbleClass =
                      message.role === "user"
                        ? "relative ml-auto min-w-0 max-w-[42rem] overflow-hidden rounded-[28px] rounded-br-[12px] bg-[linear-gradient(135deg,#7c3aed_0%,#5b7bff_100%)] px-4 py-3 text-sm text-white shadow-[0_24px_45px_-28px_rgba(91,123,255,0.9)]"
                        : "min-w-0 max-w-[42rem] overflow-hidden rounded-[28px] rounded-bl-[12px] border border-[rgba(255,255,255,0.18)] bg-[rgba(255,255,255,0.13)] px-4 py-3 text-sm text-[rgba(255,255,255,0.92)] shadow-none";

                    const inner = (
                      <div
                        className={bubbleClass}
                        data-testid="chat-message"
                        data-message-role={message.role}
                      >
                        {replyQuote ? (
                          <div
                            className={`mb-2 rounded-2xl border-l-4 border-amber-400 pl-3 ${
                              message.role === "user"
                                ? "bg-white/12"
                                : "bg-white/10"
                            }`}
                          >
                            <p
                              className={`pt-2 text-[10px] font-semibold ${
                                message.role === "user"
                                  ? "text-amber-100"
                                  : "text-amber-300"
                              }`}
                            >
                              {chatReplyLabel(replyQuote.role)}
                            </p>
                            <p
                              className={`line-clamp-5 whitespace-pre-wrap pb-2 text-[11px] leading-snug ${
                                message.role === "user"
                                  ? "text-violet-50/95"
                                  : "text-slate-300"
                              }`}
                            >
                              {replyQuote.content}
                            </p>
                          </div>
                        ) : null}
                        {dueMeta?.reminderId ? (
                          <>
                            <p className="font-semibold text-[rgba(255,255,255,0.9)]">
                              Reminder due
                            </p>
                            <p className="mt-1 min-w-0 max-w-full whitespace-pre-wrap break-words leading-relaxed text-[rgba(255,255,255,0.88)] [overflow-wrap:anywhere]">
                              {dueMeta.title}
                            </p>
                            <p className="mt-1 text-xs text-[rgba(255,255,255,0.55)]">
                              {new Date(
                                dueMeta.dueAt ?? Date.now(),
                              ).toLocaleString()}
                            </p>
                            {dueMeta.notes ? (
                              <p className="mt-1 text-xs text-[rgba(255,255,255,0.45)]">
                                {dueMeta.notes}
                              </p>
                            ) : null}
                            {dueReminderResolved ? (
                              <p className="mt-3 text-xs font-medium text-[rgba(255,255,255,0.55)]">
                                {dueReminder?.status === "done"
                                  ? "Already marked done."
                                  : "This reminder was already updated from another action."}
                              </p>
                            ) : (
                              <div className="mt-3 flex flex-wrap gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDueReminderAction(
                                      message.id,
                                      dueMeta.reminderId!,
                                      "done",
                                    )
                                  }
                                  data-testid="due-reminder-done-button"
                                  className="rounded-full bg-emerald-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500"
                                >
                                  Done
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDueReminderAction(
                                      message.id,
                                      dueMeta.reminderId!,
                                      "snooze",
                                    )
                                  }
                                  data-testid="due-reminder-snooze-button"
                                  className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-800 hover:bg-slate-50"
                                >
                                  Snooze 1h
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDueReminderAction(
                                      message.id,
                                      dueMeta.reminderId!,
                                      "reschedule",
                                    )
                                  }
                                  data-testid="due-reminder-reschedule-button"
                                  className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-semibold text-violet-900 hover:bg-violet-100"
                                >
                                  Set new time
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleDueReminderAction(
                                      message.id,
                                      dueMeta.reminderId!,
                                      "delete",
                                    )
                                  }
                                  data-testid="due-reminder-delete-button"
                                  className="rounded-full bg-rose-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-rose-500"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {/* Sender label */}
                            <p
                              className={`mb-1 text-[10px] font-bold uppercase tracking-[0.18em] ${
                                message.role === "user"
                                  ? "text-violet-100/70"
                                  : "text-[rgba(255,255,255,0.38)]"
                              }`}
                            >
                              {message.role === "user" ? "You" : "RemindOS"}
                            </p>
                            {message.meta?.kind === "briefing" ? (
                              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-400">
                                {briefingSectionLabel(
                                  message.meta.briefingSection,
                                )}
                              </p>
                            ) : null}
                            <StructuredMessage
                              content={message.content}
                              className="min-w-0 max-w-full leading-relaxed [overflow-wrap:anywhere]"
                            />
                          </>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <p
                            className={`flex min-w-0 flex-wrap items-center gap-2 text-[10px] ${
                              message.role === "user"
                                ? "text-violet-100"
                                : "text-[rgba(255,255,255,0.3)]"
                            }`}
                          >
                            <span>
                              {new Date(message.createdAt).toLocaleTimeString(
                                [],
                                {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                },
                              )}
                            </span>
                            {message.meta?.editedAt &&
                            message.role === "user" ? (
                              <span className="rounded-full bg-white/15 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-violet-50">
                                Edited
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </div>
                    );

                    return (
                      <ChatBubbleShell
                        key={message.id}
                        onReply={startReplyTo}
                        onEdit={
                          message.role === "user" && showUserEdit
                            ? startEditUser
                            : undefined
                        }
                        showEdit={message.role === "user" && showUserEdit}
                        actionAlign={message.role === "user" ? "end" : "start"}
                        showActionsAlways={message.role === "user"}
                        desktopHoverMenu
                        onLongPressEdit={
                          message.role === "user" && showUserEdit
                            ? startEditUser
                            : undefined
                        }
                      >
                        {inner}
                      </ChatBubbleShell>
                    );
                  })}
                  {isLoading ? (
                    <div className="min-w-0 max-w-[42rem] rounded-[28px] rounded-bl-[12px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.08)] px-4 py-3 text-sm text-[rgba(255,255,255,0.7)]">
                      <p className="min-w-0 break-words [overflow-wrap:anywhere]">
                        {loadingTexts[loadingTextIndex]}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              {showSuggestedQuestions && followUpQuestions.length > 0 ? (
                <div className="shrink-0 border-t border-[rgba(255,255,255,0.06)] px-4 pb-2 pt-2 sm:px-4">
                  <div className="mx-auto max-w-4xl">
                    {/* On desktop: single scrollable row so suggestions never push messages up.
                        On mobile: wrap onto multiple rows as before. */}
                    <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-nowrap sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden">
                      {followUpQuestions.map((q, i) => (
                        <button
                          key={`${q.kind}-${i}-${q.text.slice(0, 24)}`}
                          type="button"
                          disabled={briefingStreaming}
                          onClick={() => {
                            const lastUser = [...messages]
                              .reverse()
                              .find((m) => m.role === "user")?.content;
                            const taskBrief: TaskItemBrief[] = tasks.map(
                              (t) => ({
                                id: t.id,
                                title: t.title,
                                dueAt: t.dueAt,
                                status: t.status,
                                priority: t.priority,
                              }),
                            );
                            setInput(q.text);
                            setFollowUpQuestions((prev) =>
                              replaceFollowUpSlot(prev, i as 0 | 1 | 2, {
                                reminders,
                                tasks: taskBrief,
                                lastUserMessage: lastUser,
                                firstName: user?.firstName,
                              }),
                            );
                          }}
                          className={`min-h-[2.75rem] shrink-0 rounded-full border px-4 py-2 text-left text-xs font-medium leading-snug transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-0 sm:max-w-[18rem] sm:truncate sm:px-3 sm:py-1.5 ${
                            q.kind === "action"
                              ? "border-emerald-500/30 bg-emerald-600/15 text-emerald-300 hover:bg-emerald-600/25"
                              : "border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.06)] text-[rgba(255,255,255,0.7)] hover:bg-[rgba(255,255,255,0.1)]"
                          }`}
                          title={q.text}
                        >
                          {q.text}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              <form
                ref={chatFormRef}
                onSubmit={handleChatSubmit}
                data-testid="chat-form"
                className={`shrink-0 border-t border-[rgba(255,255,255,0.06)] px-3 pb-[max(5rem,calc(env(safe-area-inset-bottom)+4.5rem))] pt-3 sm:px-4 sm:pb-4 lg:pb-4 ${
                  briefingComposerLocked ? "opacity-90" : ""
                }`}
                style={{ background: "#1a1625" }}
              >
                <div className="mx-auto max-w-4xl">
                  {pendingCreateDraft?.step === "task" ? (
                    <div className="mb-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/60">
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                        Select task
                      </p>
                      <div className="flex gap-2 overflow-x-auto scroll-smooth pb-1">
                        <button
                          type="button"
                          disabled={isLoading || (briefingStreaming && !editingMessageId)}
                          onClick={() => {
                            quickSubmitTextRef.current = "no";
                            requestAnimationFrame(() => {
                              chatFormRef.current?.requestSubmit();
                            });
                          }}
                          className="shrink-0 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          Standalone
                        </button>
                        {taskLinkQuickReplies.map((task) => (
                          <button
                            key={`task-link-chip-${task.id}`}
                            type="button"
                            disabled={isLoading || (briefingStreaming && !editingMessageId)}
                            onClick={() => {
                              quickSubmitTextRef.current = task.title;
                              requestAnimationFrame(() => {
                                chatFormRef.current?.requestSubmit();
                              });
                            }}
                            className="shrink-0 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-medium text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-700 dark:bg-slate-950 dark:text-violet-200 dark:hover:bg-violet-900/30"
                          >
                            {task.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {editingMessageId ? (
                    <div className="mb-3 flex items-center justify-between gap-2 rounded-[22px] border border-violet-200 bg-violet-50 px-4 py-3 text-xs text-violet-700">
                      <span className="font-medium">Editing your message</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full border border-violet-200 px-3 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100"
                        onClick={() => {
                          setEditingMessageId(null);
                          setInput("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null}
                  {replyTarget && !editingMessageId ? (
                    <div className="mb-3 flex items-start gap-2 rounded-[22px] border border-amber-200 bg-amber-50 px-4 py-3">
                      <div className="min-w-0 flex-1 border-l-4 border-amber-400 pl-3">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-700">
                          {chatReplyLabel(replyTarget.role)}
                        </p>
                        <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-snug text-slate-700">
                          {replyTarget.content}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 rounded-full border border-amber-200 px-2.5 py-0.5 text-lg leading-none text-amber-700 hover:bg-amber-100"
                        aria-label="Cancel reply"
                        onClick={() => setReplyTarget(null)}
                      >
                        ×
                      </button>
                    </div>
                  ) : null}
                  {/* ── Suggestion chips (mobile only) ── */}
                  <div className="mb-2 flex gap-2 overflow-x-auto scrollbar-none sm:hidden">
                    {[
                      { label: "What's overdue?",  onClick: () => { setInput("What's overdue?"); chatFormRef.current?.requestSubmit(); } },
                      { label: "Create reminder",  onClick: () => showCreateOverlay({}) },
                      { label: "Run briefing",     onClick: () => runBriefingStream() },
                      { label: "What's today?",    onClick: () => { setInput("What's due today?"); chatFormRef.current?.requestSubmit(); } },
                    ].map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        onClick={chip.onClick}
                        disabled={isLoading || (briefingStreaming && !editingMessageId)}
                        className="shrink-0 rounded-full border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] px-3 py-1.5 text-[11px] font-medium text-[rgba(255,255,255,0.65)] transition hover:bg-[rgba(255,255,255,0.12)] disabled:opacity-40"
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex w-full min-w-0 items-end gap-2 rounded-[28px] border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.07)] py-2 pl-2 pr-2">
                    {/* + Create reminder — visible on mobile, hidden on sm+ */}
                    <button
                      type="button"
                      onClick={() => showCreateOverlay()}
                      disabled={briefingComposerLocked}
                      data-walkthrough="create-reminder-trigger"
                      data-testid="chat-mobile-create-reminder"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-xl font-semibold text-white shadow-sm transition hover:bg-violet-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 sm:hidden"
                      aria-label="Create reminder"
                      title="Create reminder"
                    >
                      +
                    </button>
                    <div className="relative min-h-[2.4rem] min-w-0 flex-1">
                      <textarea
                        ref={composerTextareaRef}
                        rows={1}
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        placeholder={
                          briefingComposerLocked && !editingMessageId
                            ? "Briefing in progress…"
                            : "Ask or add a reminder…"
                        }
                        readOnly={briefingComposerLocked && !editingMessageId}
                        aria-busy={briefingStreaming}
                        aria-label={
                          briefingStreaming
                            ? "Message (wait for briefing to finish)"
                            : "Message"
                        }
                        data-testid="chat-input"
                        className={`scrollbar-none relative z-10 min-h-10 w-full resize-none overflow-y-hidden rounded-2xl bg-transparent px-2 py-1.5 text-sm leading-6 text-[rgba(255,255,255,0.88)] [overflow-wrap:anywhere] outline-none placeholder:text-[rgba(255,255,255,0.35)] ${
                          briefingComposerLocked && !editingMessageId
                            ? "cursor-wait caret-transparent"
                            : ""
                        }`}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={
                        !input.trim() ||
                        isLoading ||
                        (briefingStreaming && !editingMessageId)
                      }
                      data-testid="chat-send-button"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-base font-semibold text-white shadow-md transition hover:bg-violet-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="Send message"
                    >
                      {isLoading || (briefingStreaming && !editingMessageId) ? (
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/>
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
                          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>{/* end inner wrap */}
          </div>{/* end dark chat panel */}
        </div>{/* end 3-panel container */}
      </section>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[rgba(255,255,255,0.07)] bg-[#1a1625] lg:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        {([
          {
            label: "Chat", active: !isListOpen && !isTasksOpen, badge: 0, onClick: undefined,
            icon: (active: boolean) => (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill={active ? "rgba(139,92,246,0.2)" : "none"} />
              </svg>
            ),
          },
          {
            label: "Reminders", active: isListOpen, badge: snapshot.missed, onClick: () => showReminderListOverlay(true, snapshot.missed > 0 ? "missed" : "all"),
            icon: (_active: boolean) => (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            ),
          },
          {
            label: "Tasks", active: isTasksOpen, badge: 0, onClick: openAllTasksFromSnapshot,
            icon: (_active: boolean) => (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
            ),
          },
          {
            label: "More", active: false, badge: 0, onClick: () => showSnapshotOverlay(),
            icon: (_active: boolean) => (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
              </svg>
            ),
          },
        ] as { label: string; active: boolean; badge: number; onClick: (() => void) | undefined; icon: (active: boolean) => React.ReactNode }[]).map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            className={`relative flex flex-1 flex-col items-center gap-0.5 pb-2 pt-2.5 text-[10px] font-semibold transition ${
              item.active ? "text-violet-400" : "text-[rgba(255,255,255,0.38)]"
            }`}
          >
            {/* Active indicator bar */}
            {item.active && (
              <span className="absolute inset-x-4 top-0 h-[2px] rounded-full bg-violet-500" />
            )}
            {item.icon(item.active)}
            <span>{item.label}</span>
            {item.badge > 0 && (
              <span className="absolute right-3 top-1.5 min-w-[15px] rounded-full bg-rose-500 px-1 py-0.5 text-[8px] font-bold leading-none text-white">
                {item.badge > 99 ? "99+" : item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {isSnapshotOpen && (
        <SnapshotOverlay
          snapshot={snapshot}
          laterCount={grouped.upcoming.length}
          onClose={closeSnapshotOverlay}
          onOpenReminderTab={(tab) => {
            closeSnapshotOverlay();
            showReminderListOverlay(true, tab);
          }}
          onNextTwoHours={openNextTwoHoursFromSnapshot}
          onCreateReminder={() => showCreateOverlay()}
          onAllReminders={() => showReminderListOverlay()}
          onCreateTask={() => showTasksOverlay("create")}
          onAllTasks={openAllTasksFromSnapshot}
          onRunBriefing={() => {
            closeSnapshotOverlay();
            runBriefingStream();
          }}
          onImport={() => showImportOverlay()}
          onExport={() => {
            closeSnapshotOverlay();
            handleExportChat();
          }}
          onBatch={() => showBatchOverlay()}
          isExportDisabled={isLoading || messages.length === 0}
          isBatchDisabled={isBatchRunning || isLoading}
          showSuggestedQuestions={showSuggestedQuestions}
          onToggleSuggestedQuestions={setShowSuggestedQuestions}
          dueNotifPrefs={dueNotifPrefs}
          onChangeDueNotifPrefs={(next) => {
            setDueNotifPrefs(next);
          }}
          onRequestNotifPermission={() => void requestDueNotificationPermission()}
          onClearChat={() => {
            closeSnapshotOverlay();
            void handleClearChat();
          }}
          isClearingChat={isClearingChat}
          isClearingChatDisabled={isClearingChat || isLoading}
          user={user}
          onSignOut={() => void signOut(() => router.push("/sign-in"))}
        />
      )}

      {isCreateOpen && (
        <div
          data-testid="reminder-form-overlay"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
          onClick={closeCreateOverlay}
        >
          <div
            className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            {/* ── Handle bar (mobile) ── */}
            <div className="flex shrink-0 justify-center pt-2.5 pb-1 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-slate-200" />
            </div>

            {/* ── Header ── */}
            <div className="flex shrink-0 items-center justify-between px-5 py-3">
              {editingReminderId ? (
                <button
                  type="button"
                  onClick={closeCreateOverlay}
                  className="flex items-center gap-1 text-slate-500"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="m15 18-6-6 6-6"/></svg>
                  <span className="text-[15px] font-semibold text-slate-700">Edit Reminder</span>
                </button>
              ) : (
                <h3 className="text-[17px] font-extrabold text-slate-900">New Reminder</h3>
              )}
              {editingReminderId ? (
                <button
                  type="button"
                  form="reminder-form"
                  className="rounded-full bg-violet-600 px-5 py-2 text-[13px] font-bold text-white shadow-sm"
                  onClick={(e) => { e.preventDefault(); void (document.getElementById("reminder-form") as HTMLFormElement | null)?.requestSubmit(); }}
                  data-testid="reminder-save-button"
                >
                  Update
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { resetReminderForm(); setCreateFormError(null); closeCreateOverlay(); }}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12"/></svg>
                </button>
              )}
            </div>

            <form
              id="reminder-form"
              className="min-h-0 flex-1 overflow-y-auto"
              onSubmit={handleManualCreate}
            >
              <div className="grid gap-5 px-5 pb-6 pt-1">

                {/* Title input */}
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="What do you need to remember?"
                  data-testid="reminder-title-input"
                  className="w-full border-0 border-b border-slate-200 pb-2 text-[15px] font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-violet-400"
                  autoFocus
                />

                {/* Date + Time chips */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">DATE</span>
                    <div className="relative">
                      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] font-semibold text-slate-700">
                        <span>📅</span>
                        <span>{newDate ? new Date(`${newDate}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Pick date"}</span>
                      </div>
                      <input
                        type="date"
                        min={getMinDate()}
                        value={newDate}
                        onChange={(e) => setNewDate(e.target.value)}
                        data-testid="reminder-date-input"
                        className="absolute inset-0 cursor-pointer opacity-[0.01]"
                      />
                    </div>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">TIME</span>
                    <div className="relative">
                      <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] font-semibold text-slate-700">
                        <span>🕐</span>
                        <span>{newTime ? new Date(`1970-01-01T${newTime}`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "Pick time"}</span>
                      </div>
                      <input
                        type="time"
                        value={newTime}
                        onChange={(e) => setNewTime(e.target.value)}
                        data-testid="reminder-time-input"
                        className="absolute inset-0 cursor-pointer opacity-[0.01]"
                      />
                    </div>
                  </label>
                </div>

                {/* Priority stars */}
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">PRIORITY <span className="text-rose-400">*</span></p>
                  <div className="flex gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setReminderStars(n)}
                        className={`flex h-11 w-11 items-center justify-center rounded-2xl border text-xl transition ${
                          n <= reminderStars
                            ? "border-amber-300 bg-amber-50 text-amber-400"
                            : "border-slate-200 bg-slate-50 text-slate-300"
                        }`}
                        aria-label={`${n} star${n > 1 ? "s" : ""}`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                </div>

                {/* Repeat chips */}
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">REPEAT</p>
                  <div className="flex flex-wrap gap-2">
                    {(["none", "daily", "weekly", "monthly"] as const).map((r) => {
                      const label = r === "none" ? "None" : r[0]!.toUpperCase() + r.slice(1);
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setNewRecurrence(r)}
                          data-testid={r === "none" ? "reminder-recurrence-select" : undefined}
                          className={`rounded-full px-4 py-1.5 text-[12px] font-bold transition ${
                            newRecurrence === r
                              ? "bg-violet-600 text-white"
                              : "border border-slate-200 bg-white text-slate-600"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Domain chips */}
                {(() => {
                  const editingRem = editingReminderId ? reminders.find((r) => r.id === editingReminderId) : undefined;
                  const canEditLinks = !editingRem || editingRem.access !== "shared";
                  const domainChipColors: Record<string, { active: string; text: string }> = {
                    health:  { active: "#10b981", text: "#065f46" },
                    finance: { active: "#06b6d4", text: "#155e75" },
                    career:  { active: "#6366f1", text: "#312e81" },
                    hobby:   { active: "#7c3aed", text: "#4c1d95" },
                    fun:     { active: "#f59e0b", text: "#78350f" },
                  };
                  return (
                    <div className={canEditLinks ? "" : "pointer-events-none opacity-60"}>
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">DOMAIN</p>
                      <div className="flex flex-wrap gap-2">
                        {(["health", "finance", "career", "hobby", "fun"] as const).map((d) => {
                          const active = reminderDomain === d;
                          const c = domainChipColors[d]!;
                          return (
                            <button
                              key={d}
                              type="button"
                              onClick={() => setReminderDomain(active ? "" : d)}
                              data-testid="reminder-domain-select"
                              className="rounded-full px-4 py-1.5 text-[12px] font-bold transition"
                              style={active
                                ? { background: `${c.active}22`, color: c.active, border: `1.5px solid ${c.active}` }
                                : { background: "#f8fafc", color: "#64748b", border: "1.5px solid #e2e8f0" }
                              }
                            >
                              {d}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* More options expandable */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowReminderInlineTask((v) => !v)}
                    data-testid="reminder-inline-task-toggle"
                    className="flex items-center gap-1.5 text-[12px] font-medium text-slate-400"
                  >
                    <span className={`text-base transition-transform ${showReminderInlineTask ? "rotate-90" : ""}`}>›</span>
                    More options (link task, notes…)
                  </button>

                  {showReminderInlineTask && (() => {
                    const editingRem = editingReminderId ? reminders.find((r) => r.id === editingReminderId) : undefined;
                    const canEditLinks = !editingRem || editingRem.access !== "shared";
                    return (
                      <div className="mt-3 grid gap-4">
                        {/* Linked task */}
                        <div className={!canEditLinks ? "pointer-events-none opacity-60" : ""}>
                          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">LINKED TASK</p>
                          {reminderLinkedTaskId ? (
                            <div className="flex items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-3 py-2.5">
                              <svg viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 shrink-0"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 12 2 2 4-4"/></svg>
                              <span className="flex-1 text-[13px] font-semibold text-indigo-700">
                                {tasks.find((t) => t.id === reminderLinkedTaskId)?.title ?? "Task"}
                              </span>
                              <button type="button" onClick={() => setReminderLinkedTaskId("")} className="text-[11px] font-bold text-indigo-500">Change</button>
                            </div>
                          ) : (
                            <select
                              value={reminderLinkedTaskId}
                              onChange={(e) => setReminderLinkedTaskId(e.target.value)}
                              disabled={!canEditLinks}
                              data-testid="reminder-task-select"
                              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none focus:border-violet-400"
                            >
                              <option value="">None — counts as ADHOC</option>
                              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                            </select>
                          )}
                        </div>

                        {/* Notes textarea */}
                        <div>
                          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">NOTES</p>
                          <textarea
                            rows={3}
                            value={newNotes}
                            onChange={(e) => setNewNotes(e.target.value)}
                            placeholder="Add notes…"
                            data-testid="reminder-notes-input"
                            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 outline-none focus:border-violet-400"
                          />
                        </div>

                        {/* Inline task creator */}
                        {!editingReminderId && canEditLinks && (
                          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/90 px-3 py-3">
                            <p className="mb-2 text-[11px] font-bold text-violet-700">+ Create new task &amp; link it</p>
                            <div className="grid gap-2">
                              <input
                                value={reminderInlineTaskTitle}
                                onChange={(e) => setReminderInlineTaskTitle(e.target.value)}
                                placeholder="New task title"
                                data-testid="reminder-inline-task-title-input"
                                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                              />
                              <input
                                type="datetime-local"
                                value={reminderInlineTaskDue}
                                onChange={(e) => setReminderInlineTaskDue(e.target.value)}
                                data-testid="reminder-inline-task-due-input"
                                className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
                              />
                              <button
                                type="button"
                                disabled={reminderInlineTaskSaving}
                                onClick={() => void createReminderInlineTask()}
                                data-testid="reminder-inline-task-save-button"
                                className="rounded-full bg-violet-600 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                              >
                                {reminderInlineTaskSaving ? "Creating…" : "Create task & link"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Error */}
                {createFormError && (
                  <p className="rounded-xl bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-600" role="alert" data-testid="reminder-form-error">
                    {createFormError}
                  </p>
                )}

                {/* Delete button (edit mode only) */}
                {editingReminderId && (
                  <button
                    type="button"
                    onClick={() => {
                      const rem = reminders.find((r) => r.id === editingReminderId);
                      if (rem) { closeCreateOverlay(); setPendingReminderCardDelete({ id: rem.id, title: rem.title }); }
                    }}
                    className="w-full rounded-2xl bg-rose-500 py-3.5 text-[14px] font-bold text-white"
                  >
                    Delete Reminder
                  </button>
                )}

                {/* Save button (create mode) */}
                {!editingReminderId && (
                  <button
                    type="submit"
                    data-testid="reminder-save-button"
                    className="w-full rounded-2xl bg-violet-600 py-3.5 text-[15px] font-bold text-white shadow-md shadow-violet-500/30"
                  >
                    Save Reminder
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {isListOpen && (
        <div
          data-testid="reminder-list-overlay"
          className="fixed inset-0 z-50 flex flex-col bg-[#fafaf9] sm:items-center sm:justify-center sm:bg-black/50 sm:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeReminderListOverlay(); }}
        >
          <div
            className="flex h-full w-full flex-col overflow-hidden bg-[#fafaf9] sm:h-auto sm:max-h-[min(92vh,760px)] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-slate-200 sm:shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            {/* ── Top bar ── */}
            <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] sm:pt-3">
              <button type="button" onClick={closeReminderListOverlay} className="mr-1 sm:hidden">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-5 w-5 text-slate-500"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <h2 className="flex-1 text-[18px] font-extrabold text-slate-900">Reminders</h2>
              <button
                type="button"
                onClick={openCreateReminderFromRemindersList}
                data-testid="reminder-create-button"
                className="flex items-center gap-1 rounded-full bg-violet-600 px-4 py-2 text-[13px] font-bold text-white shadow-sm transition hover:bg-violet-500"
              >
                <span className="text-base leading-none">+</span> New
              </button>
              <button type="button" className="hidden sm:block rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold" onClick={closeReminderListOverlay} data-testid="reminder-list-close">Close</button>
            </div>

            {/* ── Tabs ── */}
            <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2.5 scrollbar-none">
              {(
                [
                  ["all",       "All",      "#64748b", reminders.length],
                  ["missed",    "Missed",   "#f43f5e", grouped.missed.length],
                  ["today",     "Today",    "#f59e0b", grouped.today.length],
                  ["tomorrow",  "Tmrw",     "#7c3aed", grouped.tomorrow.length],
                  ["upcoming",  "Later",    "#06b6d4", grouped.upcoming.length],
                  ["shared",    "Shared",   "#06b6d4", sharedTabCount],
                  ["sent",      "Sent",     "#6366f1", sentTabCount],
                  ["done",      "Done",     "#10b981", grouped.done.length],
                ] as const
              ).map(([key, label, dotColor, count]) => {
                const active = reminderListTab === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setReminderListTab(key)}
                    data-testid={`reminder-tab-${key}`}
                    className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold transition ${
                      active ? "bg-violet-600 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {!active && <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: dotColor }} />}
                    {label}
                    {count > 0 && (
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold leading-none ${
                        active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"
                      }`}>{count}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* ── Missed alert banner ── */}
            {reminderListTab === "missed" && snapshot.missed > 0 && (
              <div className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5">
                <span className="h-2 w-2 rounded-full bg-rose-500 shrink-0" />
                <span className="flex-1 text-[12px] font-semibold text-rose-800">
                  {snapshot.missed} reminder{snapshot.missed > 1 ? "s" : ""} need{snapshot.missed === 1 ? "s" : ""} immediate action
                </span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="h-4 w-4 text-rose-400"><path d="m9 18 6-6-6-6"/></svg>
              </div>
            )}

            {/* ── Search / filter bar — shown on all tabs ── */}
            {reminderListTab !== "shared" && reminderListTab !== "sent" && (
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-3 py-2">
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5 shrink-0 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input
                    value={reminderSearchQuery}
                    onChange={(e) => setReminderSearchQuery(e.target.value)}
                    placeholder="Filter..."
                    className="flex-1 bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400"
                  />
                </div>
                <select
                  value={reminderTaskFilter}
                  onChange={(e) => setReminderTaskFilter(e.target.value as "all" | "adhoc" | string)}
                  className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-[11px] text-slate-600 font-medium"
                >
                  <option value="all">All types</option>
                  <option value="adhoc">ADHOC only</option>
                  {tasks.map((t) => <option key={t.id} value={t.id}>Task: {t.title}</option>)}
                </select>
              </div>
            )}

            {/* ── Bulk selection bar (non-shared tabs) ── */}
            {reminderListTab !== "shared" && reminderSelectionMode && (
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-white px-4 py-2">
                <button
                  type="button"
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700"
                  data-testid="reminder-selection-cancel"
                  onClick={() => { setReminderSelectionMode(false); setSelectedReminderIds(new Set()); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={selectedReminderIds.size === 0}
                  data-testid="reminder-selection-share"
                  className="rounded-full bg-violet-600 px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => showShareOverlay([...selectedReminderIds])}
                >
                  Share ({selectedReminderIds.size})
                </button>
              </div>
            )}

            {/* ── Shared tab: pending invites ── */}
            {reminderListTab === "shared" && shareInbox.length > 0 && (
              <div className="shrink-0 border-b border-violet-100 bg-violet-50/60 px-4 py-3">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-violet-700">Pending Invites</p>
                <div className="space-y-2">
                  {groupShareInboxRows(shareInbox).map(({ batchKey, rows }) => {
                    const first = rows[0]!;
                    const n = rows.length;
                    return (
                      <div key={batchKey} className="flex items-center justify-between gap-3 rounded-xl border border-violet-200 bg-white px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold text-slate-900">
                            {first.fromDisplayName}
                            {n > 1 ? ` · ${n} reminders` : ` · ${first.title}`}
                          </p>
                          {n > 1 && (
                            <p className="mt-0.5 truncate text-[11px] text-slate-500">
                              {rows.map((r) => r.title).join(", ")}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button
                            type="button"
                            className="rounded-full bg-violet-600 px-3 py-1 text-[11px] font-bold text-white"
                            onClick={() => void joinShareBatch(batchKey)}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-bold text-slate-600"
                            onClick={() => void dismissShareBatch(batchKey)}
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Card list ── */}
            <div className="relative min-h-0 flex-1 overflow-y-auto">
              {reminderListRows.length === 0 && !(reminderListTab === "shared" && shareInbox.length > 0) ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <span className="mb-3 text-4xl">{reminderListTab === "done" ? "✅" : reminderListTab === "missed" ? "🎉" : "🔔"}</span>
                  <p className="text-[14px] font-semibold text-slate-700">
                    {reminderListTab === "done" ? "No completed reminders yet" :
                     reminderListTab === "missed" ? "You're all caught up!" :
                     reminderListTab === "shared" ? "No joined reminders yet" :
                     "Nothing scheduled here"}
                  </p>
                  <p className="mt-1 text-[12px] text-slate-400">
                    {reminderListTab === "missed" ? "Great job staying on top of things." : "Tap + New to add one."}
                  </p>
                </div>
              ) : (
                <div className="space-y-0 px-3 py-3">
                  {(() => {
                    /* For "today" tab: group by MORNING / AFTERNOON / EVENING */
                    if (reminderListTab === "today" && reminderListRows.length > 0) {
                      const periods: { label: string; color: string; items: typeof reminderListRows }[] = [
                        { label: "MORNING", color: "#f59e0b", items: [] },
                        { label: "AFTERNOON", color: "#f59e0b", items: [] },
                        { label: "EVENING", color: "#f59e0b", items: [] },
                      ];
                      for (const r of reminderListRows) {
                        const h = new Date(r.dueAt).getHours();
                        if (h < 12) periods[0]!.items.push(r);
                        else if (h < 17) periods[1]!.items.push(r);
                        else periods[2]!.items.push(r);
                      }
                      return periods
                        .filter((p) => p.items.length > 0)
                        .map((period) => (
                          <div key={period.label} className="mb-1">
                            <p
                              className="mb-1.5 px-1 pt-2 text-[9px] font-extrabold uppercase tracking-widest"
                              style={{ color: period.color }}
                            >
                              {period.label}
                            </p>
                            <div className="space-y-2">
                              {period.items.map((reminder) => (
                                <ReminderCard
                                  key={reminder.id}
                                  reminder={reminder}
                                  tab={reminderListTab}
                                  selectionMode={reminderSelectionMode}
                                  selected={selectedReminderIds.has(reminder.id)}
                                  taskTitleById={taskTitleById}
                                  onSelect={toggleReminderSelect}
                                  onLongPressStart={(id) => {
                                    if (reminder.access === "shared" || reminder.status === "done" || reminder.status === "archived") return;
                                    reminderLongPressTimerRef.current = window.setTimeout(() => {
                                      reminderLongPressTimerRef.current = null;
                                      setReminderSelectionMode(true);
                                      toggleReminderSelect(id);
                                      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(35);
                                    }, 450);
                                  }}
                                  onLongPressEnd={() => {
                                    const t = reminderLongPressTimerRef.current;
                                    if (t != null) { window.clearTimeout(t); reminderLongPressTimerRef.current = null; }
                                  }}
                                  onMarkDone={() => void refreshAfterReminderMutation(
                                    fetch(`/api/reminders/${reminder.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) })
                                  ).catch(() => showShareToast("Could not update reminder. Try again."))}
                                  onDelete={() => setPendingReminderCardDelete({ id: reminder.id, title: reminder.title })}
                                  onEdit={() => openEditModal(reminder)}
                                  onShare={() => showShareOverlay([reminder.id])}
                                  onSnooze={() => void refreshAfterReminderMutation(
                                    // Fix B4: PATCH route expects a numeric timestamp, not an ISO string
                                    fetch(`/api/reminders/${reminder.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueAt: new Date(reminder.dueAt).getTime() + 60 * 60 * 1000 }) })
                                  ).catch(() => showShareToast("Could not snooze reminder."))}
                                />
                              ))}
                            </div>
                          </div>
                        ));
                    }

                    /* For "done" tab: group by TODAY / YESTERDAY / EARLIER */
                    if (reminderListTab === "done" && reminderListRows.length > 0) {
                      const now = new Date();
                      const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
                      const startYesterday = new Date(startToday); startYesterday.setDate(startYesterday.getDate() - 1);
                      const groups: { label: string; items: typeof reminderListRows }[] = [
                        { label: "TODAY", items: [] },
                        { label: "YESTERDAY", items: [] },
                        { label: "EARLIER", items: [] },
                      ];
                      for (const r of reminderListRows) {
                        const d = new Date(r.dueAt);
                        if (d >= startToday) groups[0]!.items.push(r);
                        else if (d >= startYesterday) groups[1]!.items.push(r);
                        else groups[2]!.items.push(r);
                      }
                      return groups
                        .filter((g) => g.items.length > 0)
                        .map((group) => (
                          <div key={group.label} className="mb-1">
                            <p className="mb-1.5 px-1 pt-2 text-[9px] font-extrabold uppercase tracking-widest text-emerald-600">
                              {group.label}
                            </p>
                            <div className="space-y-2">
                              {group.items.map((reminder) => (
                                <ReminderCard
                                  key={reminder.id}
                                  reminder={reminder}
                                  tab={reminderListTab}
                                  selectionMode={reminderSelectionMode}
                                  selected={selectedReminderIds.has(reminder.id)}
                                  taskTitleById={taskTitleById}
                                  onSelect={toggleReminderSelect}
                                  onLongPressStart={() => {}}
                                  onLongPressEnd={() => {
                                    const t = reminderLongPressTimerRef.current;
                                    if (t != null) { window.clearTimeout(t); reminderLongPressTimerRef.current = null; }
                                  }}
                                  onMarkDone={() => {}}
                                  onDelete={() => setPendingReminderCardDelete({ id: reminder.id, title: reminder.title })}
                                  onEdit={() => openEditModal(reminder)}
                                  onShare={() => showShareOverlay([reminder.id])}
                                  onSnooze={() => {}}
                                />
                              ))}
                            </div>
                          </div>
                        ));
                    }

                    /* All other tabs: flat list */
                    return reminderListRows.map((reminder) => (
                      <ReminderCard
                        key={reminder.id}
                        reminder={reminder}
                        tab={reminderListTab}
                        selectionMode={reminderSelectionMode}
                        selected={selectedReminderIds.has(reminder.id)}
                        taskTitleById={taskTitleById}
                        onSelect={toggleReminderSelect}
                        onLongPressStart={(id) => {
                          if (reminder.access === "shared" || reminder.status === "done" || reminder.status === "archived") return;
                          reminderLongPressTimerRef.current = window.setTimeout(() => {
                            reminderLongPressTimerRef.current = null;
                            setReminderSelectionMode(true);
                            toggleReminderSelect(id);
                            if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(35);
                          }, 450);
                        }}
                        onLongPressEnd={() => {
                          const t = reminderLongPressTimerRef.current;
                          if (t != null) { window.clearTimeout(t); reminderLongPressTimerRef.current = null; }
                        }}
                        onMarkDone={() => void refreshAfterReminderMutation(
                          fetch(`/api/reminders/${reminder.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) })
                        ).catch(() => showShareToast("Could not update reminder. Try again."))}
                        onDelete={() => setPendingReminderCardDelete({ id: reminder.id, title: reminder.title })}
                        onEdit={() => openEditModal(reminder)}
                        onShare={() => showShareOverlay([reminder.id])}
                        onSnooze={() => void refreshAfterReminderMutation(
                          // Fix B4: PATCH route expects a numeric timestamp, not an ISO string
                          fetch(`/api/reminders/${reminder.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dueAt: new Date(reminder.dueAt).getTime() + 60 * 60 * 1000 }) })
                        ).catch(() => showShareToast("Could not snooze reminder."))}
                      />
                    ));
                  })()}
                </div>
              )}

              {/* ── FAB new reminder ── */}
              <button
                type="button"
                onClick={openCreateReminderFromRemindersList}
                data-testid="reminder-fab-button"
                className="fixed bottom-20 right-4 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-violet-600 text-white shadow-lg shadow-violet-500/40 transition hover:bg-violet-500 active:scale-95 lg:hidden"
                aria-label="New reminder"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {taskActionWarning ? (
        <div
          data-testid="task-warning-modal"
          className="fixed inset-0 z-[54] flex items-end justify-center bg-black/50 p-3 sm:items-center sm:p-4"
          onClick={() => setTaskActionWarning(null)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-600 dark:text-amber-300">
                Warning
              </p>
              <h3 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {taskActionWarning.action === "delete"
                  ? "Delete task with pending reminders?"
                  : "Close task with incomplete reminders?"}
              </h3>
            </div>
            <div className="grid gap-4 px-5 py-5">
              <p
                className="text-sm leading-6 text-slate-600 dark:text-slate-300"
                data-testid="task-warning-text"
              >
                {taskActionWarning.action === "delete"
                  ? `Deleting "${taskActionWarning.task.title}" will unlink ${taskActionWarning.pendingReminderCount} pending reminder${
                      taskActionWarning.pendingReminderCount === 1 ? "" : "s"
                    }. They will stay in your reminder list as ADHOC items.`
                  : `"${taskActionWarning.task.title}" still has ${taskActionWarning.pendingReminderCount} incomplete reminder${
                      taskActionWarning.pendingReminderCount === 1 ? "" : "s"
                    }. Continue only if you still want to mark the task done.`}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={confirmTaskWarning}
                  data-testid="task-warning-confirm"
                  className={`flex-1 rounded-full px-4 py-3 text-sm font-semibold text-white transition ${
                    taskActionWarning.action === "delete"
                      ? "bg-rose-600 hover:bg-rose-500"
                      : "bg-amber-600 hover:bg-amber-500"
                  }`}
                >
                  {taskActionWarning.action === "delete"
                    ? "Delete task"
                    : "Mark task done"}
                </button>
                <button
                  type="button"
                  onClick={() => setTaskActionWarning(null)}
                  data-testid="task-warning-cancel"
                  className="rounded-full border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {pendingReminderCardDelete ? (
        <div
          className="fixed inset-0 z-[54] flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setPendingReminderCardDelete(null)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-[28px] bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center gap-3 px-6 pt-8 pb-5 text-center">
              {/* Rose trash icon */}
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-rose-100">
                <svg viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                </svg>
              </div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-rose-500">CONFIRM DELETE</p>
              <h3 className="text-[18px] font-extrabold text-slate-900">Delete reminder?</h3>
              <p className="text-[13px] leading-relaxed text-slate-500">
                &ldquo;{pendingReminderCardDelete.title}&rdquo; will be permanently deleted. This cannot be undone.
              </p>
            </div>
            <div className="grid gap-2 px-5 pb-8">
              <button
                type="button"
                onClick={async () => {
                  const { id } = pendingReminderCardDelete;
                  setPendingReminderCardDelete(null);
                  await refreshAfterReminderMutation(
                    fetch(`/api/reminders/${id}`, { method: "DELETE" }),
                  );
                }}
                className="w-full rounded-2xl bg-rose-500 py-3.5 text-[14px] font-bold text-white transition hover:bg-rose-400"
                data-testid="reminder-delete-confirm"
              >
                Delete Reminder
              </button>
              <button
                type="button"
                onClick={() => setPendingReminderCardDelete(null)}
                className="w-full py-3 text-[14px] font-semibold text-slate-500"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isShareOpen && (
        <ShareOverlay
          shareReminderIds={shareReminderIds}
          reminders={reminders}
          directoryUsers={directoryUsers}
          directoryLoading={directoryLoading}
          directoryError={directoryError}
          selectedShareUserIds={selectedShareUserIds}
          shareSending={shareSending}
          onToggleUser={toggleShareUser}
          onSend={() => void sendShares()}
          onClose={closeShareOverlay}
          getDisplayName={directoryDisplayName}
        />
      )}

      <TaskListOverlay
        open={isTasksOpen && taskMode === "browse"}
        taskTab={taskTab}
        setTaskTab={setTaskTab}
        taskSearchQuery={taskSearchQuery}
        setTaskSearchQuery={setTaskSearchQuery}
        tasksGrouped={tasksGrouped}
        reminders={reminders}
        onClose={closeTasksOverlay}
        onViewReminders={openReminderListFromTasksPanel}
        onCreateTask={() => {
          setTaskMode("create");
          showTasksOverlay("create");
        }}
        onEditTask={openTaskEdit}
        onToggleStatus={requestTaskStatusToggle}
        onDeleteTask={requestTaskDelete}
        onCreateLinkedReminder={openLinkedReminderForTask}
        onReminderMarkDone={(reminder) =>
          handleTaskReminderAction(reminder, "done")
        }
        onReminderEdit={openEditModal}
        onReminderReschedule={openTaskReminderReschedule}
        onReminderDelete={(reminder) =>
          handleTaskReminderAction(reminder, "delete")
        }
      />

      <TaskFormOverlay
        open={isTasksOpen && taskMode === "create"}
        editingTaskId={editingTaskId}
        taskFormTitle={taskFormTitle}
        setTaskFormTitle={setTaskFormTitle}
        taskFormDue={taskFormDue}
        setTaskFormDue={setTaskFormDue}
        taskFormNotes={taskFormNotes}
        setTaskFormNotes={setTaskFormNotes}
        taskFormDomain={taskFormDomain}
        setTaskFormDomain={setTaskFormDomain}
        taskStars={taskStars}
        setTaskStars={setTaskStars}
        taskFormError={taskFormError}
        setTaskFormError={setTaskFormError}
        taskDueUserEdited={taskDueUserEdited}
        setTaskDueUserEdited={setTaskDueUserEdited}
        onSubmit={handleTaskSave}
        onCancelEdit={resetTaskForm}
        onClose={closeTasksOverlay}
        onViewReminders={openReminderListFromTasksPanel}
        onCreateLinkedReminder={() => void startReminderForCurrentTask()}
      />

      {isImportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
          onClick={closeImportOverlay}
        >
          <div
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:rounded-[28px] dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Handle (mobile) */}
            <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-slate-200 dark:bg-slate-700" />
            </div>

            <div className="max-h-[90vh] overflow-y-auto px-6 pb-8 pt-4">
              {/* Header */}
              <div className="mb-5 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-900/40">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5 h-[18px] w-[18px]">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-[17px] font-extrabold text-slate-900 dark:text-slate-100">
                    Import Data
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    CSV or JSON — reminders &amp; tasks
                  </p>
                </div>
              </div>

              <form onSubmit={handleJsonImport} className="space-y-4">
                {/* Drop zone */}
                <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center dark:border-slate-700 dark:bg-slate-800/50">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8 text-slate-300 dark:text-slate-600">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                    Drop CSV or JSON here
                  </p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    .csv · .json accepted
                  </p>
                </div>

                {/* Separator */}
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-slate-100 dark:bg-slate-800" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    Or paste JSON / CSV
                  </span>
                  <div className="h-px flex-1 bg-slate-100 dark:bg-slate-800" />
                </div>

                {/* Textarea */}
                <textarea
                  value={importJson}
                  onChange={(event) => setImportJson(event.target.value)}
                  rows={7}
                  placeholder={'{\n  "tasks": [{"ref":"task-1","title":"Test task"}],\n  "reminders": [{"title":"Test reminder","dueAt":"2026-04-12T08:00:00.000Z"}]\n}'}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xs text-slate-800 placeholder-slate-400 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:placeholder-slate-600"
                />

                {/* Expected format card */}
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/40 dark:bg-amber-900/20">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                    Expected Format
                  </p>
                  <p className="mt-1 font-mono text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                    {`{ "reminders": [...] }`} or{" "}
                    {`{ "tasks": [...], "reminders": [...] }`}
                  </p>
                </div>

                {/* Status */}
                {importStatus ? (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {importStatus}
                  </p>
                ) : null}

                {/* Buttons */}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setImportStatus(null);
                      closeImportOverlay();
                    }}
                    className="flex-1 rounded-2xl border border-slate-200 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!importJson.trim() || isImporting}
                    className="flex-1 rounded-2xl bg-violet-600 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isImporting ? "Importing…" : "Import"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {shareToast ? (
        <div
          className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[60] -translate-x-1/2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 shadow-lg dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          role="status"
          aria-live="polite"
        >
          {shareToast}
        </div>
      ) : null}

      {rescheduleReminder ? (() => {
        /* Compute which preset matches current value */
        const now = new Date();
        const presets = [
          { label: "+15 min", sub: "tonight", minutes: 15, testId: "reschedule-preset--15m" },
          { label: "+1 hour", sub: "in 1h",   minutes: 60, testId: "reschedule-preset--1h" },
          { label: "Tomorrow", sub: "morning", minutes: 24 * 60, testId: "reschedule-preset-tomorrow" },
        ];
        const activePresetIdx = presets.findIndex((p) => {
          const target = new Date(now.getTime() + p.minutes * 60 * 1000);
          return rescheduleReminder.value === toDateTimeLocalValue(target.toISOString());
        });
        return (
          <div
            data-testid="reschedule-reminder-modal"
            className="fixed inset-0 z-[66] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
            onClick={() => setRescheduleReminder(null)}
          >
            <div
              className="w-full max-w-md overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:rounded-[28px]"
              onClick={(event) => event.stopPropagation()}
            >
              {/* Handle */}
              <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
                <div className="h-1 w-10 rounded-full bg-slate-200" />
              </div>

              <div className="px-6 pb-8 pt-4">
                {/* Header */}
                <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-500">RESCHEDULE</p>
                <h3 className="mt-0.5 text-[20px] font-extrabold text-slate-900">{rescheduleReminder.title}</h3>
                <p className="mt-0.5 text-[13px] text-slate-400">Choose a new date and time</p>

                {/* Quick preset chips */}
                <div className="mt-5 grid grid-cols-3 gap-3">
                  {presets.map((preset, idx) => (
                    <button
                      key={preset.label}
                      type="button"
                      data-testid={preset.testId}
                      className={`flex flex-col items-center gap-0.5 rounded-2xl border px-3 py-3 text-center transition ${
                        activePresetIdx === idx
                          ? "border-violet-500 bg-violet-600 text-white"
                          : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                      }`}
                      onClick={() => {
                        const next = new Date();
                        next.setMinutes(next.getMinutes() + preset.minutes);
                        setRescheduleReminder((prev) =>
                          prev ? { ...prev, value: toDateTimeLocalValue(next.toISOString()), error: null } : prev,
                        );
                      }}
                    >
                      <span className="text-[13px] font-extrabold">{preset.label}</span>
                      <span className={`text-[10px] font-medium ${activePresetIdx === idx ? "text-violet-200" : "text-slate-400"}`}>{preset.sub}</span>
                    </button>
                  ))}
                </div>

                {/* Custom date/time input */}
                <div className="mt-4">
                  <div className="relative flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5">
                    <div className="flex-1">
                      <p className="text-[14px] font-semibold text-slate-700">
                        {rescheduleReminder.value
                          ? new Date(rescheduleReminder.value.replace("T", " ")).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                          : "Custom date & time"}
                      </p>
                    </div>
                    <svg viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" className="h-5 w-5 shrink-0">
                      <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                    </svg>
                    <input
                      type="datetime-local"
                      min={currentDateTimeLocalValue()}
                      value={rescheduleReminder.value}
                      onChange={(event) =>
                        setRescheduleReminder((prev) =>
                          prev ? { ...prev, value: event.target.value, error: null } : prev,
                        )
                      }
                      data-testid="reschedule-datetime-input"
                      className="absolute inset-0 cursor-pointer opacity-[0.01]"
                    />
                  </div>
                </div>

                {rescheduleReminder.error && (
                  <p className="mt-2 text-[12px] font-semibold text-rose-600" role="alert" data-testid="reschedule-error">
                    {rescheduleReminder.error}
                  </p>
                )}

                {/* Action buttons */}
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setRescheduleReminder(null)}
                    data-testid="reschedule-cancel-button"
                    className="rounded-2xl border border-slate-200 py-3.5 text-[14px] font-bold text-slate-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void commitRescheduleReminder()}
                    data-testid="reschedule-save-button"
                    className="rounded-2xl bg-violet-600 py-3.5 text-[14px] font-bold text-white"
                  >
                    Save New Time
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })() : null}

      {showReminderSuccess ? (
        <div className="pointer-events-none fixed inset-0 z-[65] flex flex-col items-center justify-center gap-3">
          <div className="relative">
            <span className="absolute inset-0 rounded-full bg-emerald-400/30 animate-ping" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 shadow-2xl shadow-emerald-500/40 ring-4 ring-emerald-200">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-10 w-10">
                <path d="m5 12 4 4 10-10" />
              </svg>
            </div>
          </div>
          <div className="text-center">
            <p className="text-[20px] font-extrabold text-slate-900">Reminder saved!</p>
            {reminderSuccessInfo && (
              <p className="mt-0.5 text-[13px] text-slate-500">
                {reminderSuccessInfo.title} · {reminderSuccessInfo.time}
              </p>
            )}
          </div>
        </div>
      ) : null}

      <WalkthroughOverlay
        open={walkthroughOpen}
        step={WALKTHROUGH_STEPS[walkthroughStepIndex] ?? WALKTHROUGH_STEPS[0]!}
        stepIndex={walkthroughStepIndex}
        stepCount={WALKTHROUGH_STEPS.length}
        onNext={advanceWalkthrough}
        onClose={closeWalkthrough}
      />

      {isBatchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
          onClick={closeBatchOverlay}
        >
          <div
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] bg-white shadow-2xl sm:rounded-[28px] dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Handle (mobile) */}
            <div className="flex justify-center pt-2.5 pb-1 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-slate-200 dark:bg-slate-700" />
            </div>

            <div className="max-h-[90vh] overflow-y-auto px-6 pb-8 pt-4">
              {/* Header */}
              <div className="mb-5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setBatchStatus(null);
                    closeBatchOverlay();
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                  aria-label="Close"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02z" clipRule="evenodd" />
                  </svg>
                </button>
                <div>
                  <h3 className="text-[17px] font-extrabold text-slate-900 dark:text-slate-100">
                    Batch Questions
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Run multiple questions in one go
                  </p>
                </div>
              </div>

              <form onSubmit={handleBatchQuestions} className="space-y-4">
                {/* Info card */}
                <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-3 dark:border-cyan-800/40 dark:bg-cyan-900/20">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
                    What is this?
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-cyan-800 dark:text-cyan-200">
                    Paste an array of questions and the AI will answer each one
                    sequentially, saving you time when reviewing multiple reminders.
                  </p>
                </div>

                {/* Label */}
                <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-slate-400">
                  Questions JSON
                </p>

                {/* Code textarea */}
                <textarea
                  value={batchJson}
                  onChange={(event) => setBatchJson(event.target.value)}
                  rows={8}
                  placeholder={'{\n  "questions": [\n    "What is due today?",\n    "Show missed reminders",\n    "What is next?"\n  ]\n}'}
                  className="w-full rounded-2xl border border-slate-700 bg-[#1a1625] px-4 py-3 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-900/40"
                />

                {/* Status */}
                {batchStatus ? (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {batchStatus}
                  </p>
                ) : null}

                {/* Buttons */}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setBatchStatus(null);
                      closeBatchOverlay();
                    }}
                    className="flex-1 rounded-2xl border border-slate-200 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!batchJson.trim() || isBatchRunning}
                    className="flex-1 rounded-2xl bg-indigo-600 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBatchRunning ? "Running…" : "Run Batch"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
