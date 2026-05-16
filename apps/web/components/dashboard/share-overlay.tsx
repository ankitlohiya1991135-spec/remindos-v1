"use client";

/**
 * ShareOverlay
 *
 * Modal sheet for sharing one or more reminders with other users.
 * Displays a searchable user directory with avatar chips and a send button.
 *
 * Extracted from dashboard-workspace.tsx.
 */

import { useState } from "react";
import type { ReminderItem } from "@repo/reminder";
import type { DirectoryUser } from "./dashboard-types";

export interface ShareOverlayProps {
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
}

export function ShareOverlay({
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
}: ShareOverlayProps) {
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
