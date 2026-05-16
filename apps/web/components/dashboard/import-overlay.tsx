"use client";

/**
 * ImportOverlay
 *
 * Modal sheet for importing reminders and tasks from JSON or CSV.
 * Manages its own form state (importJson, importStatus, isImporting) internally.
 * Extracted from dashboard-workspace.tsx.
 */

import { useState } from "react";

export interface ImportOverlayProps {
  refreshReminders: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  onClose: () => void;
}

export function ImportOverlay({
  refreshReminders,
  refreshTasks,
  onClose,
}: ImportOverlayProps) {
  const [importJson, setImportJson] = useState("");
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
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
        setImportStatus("Invalid JSON. Please paste a valid JSON object or array.");
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

  const handleCancel = () => {
    setImportStatus(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={handleCancel}
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
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
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

          <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
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
                onClick={handleCancel}
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
  );
}
