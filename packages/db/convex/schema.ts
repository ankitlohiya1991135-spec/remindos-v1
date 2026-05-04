import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const lifeDomain = v.union(
  v.literal("health"),
  v.literal("finance"),
  v.literal("career"),
  v.literal("hobby"),
  v.literal("fun")
);

const reminders = defineTable({
  userId: v.string(),
  title: v.string(),
  notes: v.optional(v.string()),
  dueAt: v.number(),
  status: v.union(v.literal("pending"), v.literal("done"), v.literal("archived")),
  recurrence: v.optional(
    v.union(v.literal("none"), v.literal("daily"), v.literal("weekly"), v.literal("monthly"))
  ),
  priority: v.optional(v.number()),
  urgency: v.optional(v.number()),
  tags: v.optional(v.array(v.string())),
  linkedTaskId: v.optional(v.id("tasks")),
  domain: v.optional(lifeDomain),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_user_dueAt", ["userId", "dueAt"])
  .index("by_user_status_dueAt", ["userId", "status", "dueAt"])
  .index("by_linked_task", ["linkedTaskId"]);

const reminderInvites = defineTable({
  token: v.string(),
  reminderId: v.id("reminders"),
  ownerUserId: v.string(),
  createdAt: v.number(),
})
  .index("by_token", ["token"])
  .index("by_reminder", ["reminderId"]);

const reminderParticipants = defineTable({
  reminderId: v.id("reminders"),
  userId: v.string(),
  displayName: v.string(),
  acceptedAt: v.number(),
})
  .index("by_reminder", ["reminderId"])
  .index("by_reminder_user", ["reminderId", "userId"])
  .index("by_user", ["userId"]);

/** In-app delivery: owner shared a reminder — recipient sees it until joined or dismissed. */
const reminderShareInbox = defineTable({
  reminderId: v.id("reminders"),
  token: v.string(),
  fromUserId: v.string(),
  fromDisplayName: v.string(),
  toUserId: v.string(),
  title: v.string(),
  dueAt: v.number(),
  createdAt: v.number(),
  dismissed: v.optional(v.boolean()),
  /** Same id for all rows created in one share-send (per recipient batch). */
  shareBatchId: v.optional(v.string()),
})
  .index("by_to_user_created", ["toUserId", "createdAt"])
  .index("by_to_reminder", ["toUserId", "reminderId"])
  .index("by_to_user_batch", ["toUserId", "shareBatchId"]);

/**
 * Deduplication log for server-side push notifications.
 * Prevents the cron from sending the same notification type twice for the same reminder.
 */
const pushNotificationLogs = defineTable({
  userId: v.string(),
  reminderId: v.optional(v.string()),   // null for account-level notifs (morning briefing, etc.)
  /** due_reminder | pre_due_reminder | overdue_nudge | morning_briefing */
  type: v.string(),
  sentAt: v.number(),
})
  .index("by_user_type_reminder", ["userId", "type", "reminderId"])
  .index("by_user_type_sentAt", ["userId", "type", "sentAt"]);

/**
 * In-app notification center — persisted history shown in the bell dropdown.
 * Separate from push logs: every push also inserts one notification row so
 * the user can see a full history even if they missed the push.
 */
const notifications = defineTable({
  userId: v.string(),
  type: v.string(),          // same enum as pushNotificationLogs.type
  title: v.string(),         // notification heading (e.g. reminder title)
  body: v.string(),          // full notification text
  reminderId: v.optional(v.string()),
  read: v.boolean(),
  createdAt: v.number(),
})
  .index("by_user_created", ["userId", "createdAt"])
  .index("by_user_read", ["userId", "read"]);

/** Web Push subscriptions for PWA (one row per endpoint / device). */
const pushSubscriptions = defineTable({
  userId: v.string(),
  endpoint: v.string(),
  p256dh: v.string(),
  auth: v.string(),
  createdAt: v.number(),
})
  .index("by_user", ["userId"])
  .index("by_endpoint", ["endpoint"]);

const tasks = defineTable({
  userId: v.string(),
  title: v.string(),
  notes: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  status: v.union(v.literal("pending"), v.literal("done")),
  /** 1–5, higher = more important (same as reminders). */
  priority: v.optional(v.number()),
  domain: v.optional(lifeDomain),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_user_status", ["userId", "status"]);

const chatMessages = defineTable({
  userId: v.string(),
  /** Client-generated id for idempotent sync */
  clientId: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
  content: v.string(),
  createdAt: v.number(),
  metaJson: v.optional(v.string()),
})
  .index("by_user", ["userId"])
  .index("by_user_created", ["userId", "createdAt"]);

const userProfiles = defineTable({
  userId: v.string(),
  preferredWorkingHoursStart: v.optional(v.number()),
  preferredWorkingHoursEnd: v.optional(v.number()),
  dominantDomain: v.optional(lifeDomain),
  avgCompletionDelayMinutes: v.optional(v.number()),
  topTags: v.optional(v.array(v.string())),
  updatedAt: v.number(),
}).index("by_user", ["userId"]);

const userEvents = defineTable({
  userId: v.string(),
  eventType: v.union(
    v.literal("reminder_completed"),
    v.literal("reminder_deleted"),
    v.literal("reminder_created"),
    v.literal("task_completed"),
    v.literal("task_created"),
  ),
  entityId: v.optional(v.string()),
  entityTitle: v.optional(v.string()),
  domain: v.optional(lifeDomain),
  metadata: v.optional(v.string()),
  createdAt: v.number(),
})
  .index("by_user_created", ["userId", "createdAt"])
  .index("by_user_type", ["userId", "eventType"]);

/**
 * Persistent user knowledge wiki — one document per "page".
 * Pages are written deterministically (no LLM cost) after every
 * ingest event and read by the chat route to give the LLM rich,
 * pre-synthesised context about the user.
 *
 * Page types:
 *   behavior_summary   — overall completion rates, streaks, activity patterns
 *   domain_health      — health reminder habits
 *   domain_finance     — finance reminder habits
 *   domain_career      — career reminder habits
 *   domain_hobby       — hobby reminder habits
 *   domain_fun         — fun reminder habits
 *   avoidance_patterns — reminders repeatedly created but never completed
 *   recent_week        — rolling 7-day summary (most current context)
 */
const userWiki = defineTable({
  userId: v.string(),
  pageType: v.string(),   // one of the page types listed above
  content: v.string(),    // plain-text wiki page — max ~150 words
  updatedAt: v.number(),
})
  .index("by_user", ["userId"])
  .index("by_user_page", ["userId", "pageType"]);

export default defineSchema({
  reminders,
  reminderInvites,
  reminderParticipants,
  reminderShareInbox,
  pushSubscriptions,
  pushNotificationLogs,
  notifications,
  tasks,
  chatMessages,
  userProfiles,
  userEvents,
  userWiki,
});
