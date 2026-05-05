import { api } from "@repo/db/convex/api";
import { getConvexClient } from "./convex-client";


export type ChatMessageMeta = {
  kind?: "due_reminder";
  reminderId?: string;
  dueAt?: number;
  title?: string;
  notes?: string;
  /** Quoted message when the user replied in-thread (WhatsApp-style). */
  replyTo?: { id: string; content: string; role: "user" | "assistant" | "system" };
  editedAt?: string;
};

export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  meta?: ChatMessageMeta;
}

function toStored(row: {
  clientId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  metaJson?: string;
}): StoredChatMessage {
  return {
    id: row.clientId,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.createdAt).toISOString(),
    meta: row.metaJson
      ? (() => {
          try {
            return JSON.parse(row.metaJson) as ChatMessageMeta;
          } catch {
            return undefined;
          }
        })()
      : undefined,
  };
}

export async function getChatHistory(userId: string): Promise<StoredChatMessage[]> {
  try {
    const client = getConvexClient();
    const rows = await client.query(api.chat.listForUser, { userId });
    return rows.map(toStored);
  } catch {
    return [];
  }
}

/**
 * Persist chat messages to Convex via upsert-by-clientId (idempotent — safe to call
 * multiple times; never duplicates because the Convex mutation skips existing clientIds).
 *
 * Called by POST /api/chat/history which is invoked by flushChatHistoryToServer()
 * (debounced on every message, on tab hide, and on page unload via sendBeacon).
 */
export async function appendChatMessages(userId: string, messages: StoredChatMessage[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const client = getConvexClient();
    await client.mutation(api.chat.upsertMessages, {
      userId,
      messages: messages.map((m) => ({
        clientId: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        ...(m.meta ? { metaJson: JSON.stringify(m.meta) } : {}),
      })),
    });
  } catch {
    // Best-effort — client will retry on next flush/tab-hide
  }
}

export async function clearChatHistory(userId: string) {
  const client = getConvexClient();
  await client.mutation(api.chat.clearForUser, { userId });
}
