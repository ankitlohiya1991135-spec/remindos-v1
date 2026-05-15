"use client";

/**
 * BatchOverlay
 *
 * Modal sheet for running multiple AI questions in one go.
 * Manages batchJson, batchStatus, isBatchRunning internally.
 * Parent must pass an onRun callback that returns status strings.
 * Extracted from dashboard-workspace.tsx.
 */

import { useState, useRef } from "react";

export interface BatchOverlayProps {
  onClose: () => void;
  /** Called with the raw JSON string. Returns status messages via the provided setter. */
  onRun: (
    rawJson: string,
    setStatus: (s: string | null) => void,
    setRunning: (b: boolean) => void,
    clearJson: () => void,
  ) => Promise<void>;
}

export function BatchOverlay({ onClose, onRun }: BatchOverlayProps) {
  const [batchJson, setBatchJson] = useState("");
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const runningRef = useRef(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!batchJson.trim() || runningRef.current) return;
    runningRef.current = true;
    setIsBatchRunning(true);
    setBatchStatus(null);
    try {
      await onRun(
        batchJson,
        setBatchStatus,
        setIsBatchRunning,
        () => setBatchJson(""),
      );
    } finally {
      runningRef.current = false;
    }
  };

  const handleCancel = () => {
    setBatchStatus(null);
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
            <button
              type="button"
              onClick={handleCancel}
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

          <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
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
                onClick={handleCancel}
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
  );
}
