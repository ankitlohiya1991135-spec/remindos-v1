"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminNote } from "@repo/admin/types";

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AdminNotesPanel({ userId }: { userId: string }) {
  const [notes, setNotes] = useState<AdminNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/notes`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { notes: AdminNote[] };
      setNotes(data.notes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = newContent.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      setNewContent("");
      void refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <header className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
          Internal notes
        </h3>
        <p className="text-[11px] text-slate-400">
          Private to staff. Visible to anyone with admin access.
        </p>
      </header>

      {/* Add form */}
      <form onSubmit={handleAdd} className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Add a note (max 2000 chars)"
          maxLength={2000}
          rows={2}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={saving || !newContent.trim()}
            className="rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500 disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add note"}
          </button>
        </div>
      </form>

      {error && (
        <p className="px-5 py-3 text-xs text-rose-700 dark:text-rose-300">{error}</p>
      )}

      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {loading && (
          <li className="px-5 py-6 text-center text-xs text-slate-400">Loading…</li>
        )}
        {!loading && notes.length === 0 && (
          <li className="px-5 py-6 text-center text-xs text-slate-400">
            No notes yet.
          </li>
        )}
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} onChanged={() => void refetch()} />
        ))}
      </ul>
    </section>
  );
}

function NoteRow({
  note,
  onChanged,
}: {
  note: AdminNote;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/notes/${encodeURIComponent(note.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft.trim() }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this note?")) return;
    setWorking(true);
    try {
      const res = await fetch(`/api/admin/notes/${encodeURIComponent(note.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <li className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            <strong>{note.authorDisplay}</strong> · {formatDateTime(note.createdAt)}
            {note.updatedAt !== note.createdAt && (
              <span className="ml-1 text-slate-400">(edited)</span>
            )}
          </p>
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={2000}
              rows={3}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100">
              {note.content}
            </p>
          )}
          {error && (
            <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>
          )}
        </div>
        {note.canEdit && (
          <div className="flex shrink-0 gap-1">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={working || draft.trim().length === 0}
                  className="rounded-full bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft(note.content);
                    setError(null);
                  }}
                  disabled={working}
                  className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={working}
                  className="rounded-full border border-rose-300 px-3 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/60 dark:text-rose-300"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
