"use client";

/**
 * RescheduleReminderModal
 *
 * Bottom-sheet modal for picking a new due date/time for a reminder.
 * Extracted from dashboard-workspace.tsx.
 */

import type { Dispatch, SetStateAction } from "react";
import { toDateTimeLocalValue, currentDateTimeLocalValue } from "./dashboard-utils";

export interface RescheduleReminderState {
  messageId: string;
  reminderId: string;
  title: string;
  value: string;
  error: string | null;
}

export interface RescheduleReminderModalProps {
  rescheduleReminder: RescheduleReminderState;
  setRescheduleReminder: Dispatch<SetStateAction<RescheduleReminderState | null>>;
  onSave: () => void;
}

const PRESETS = [
  { label: "+15 min", sub: "tonight",  minutes: 15,     testId: "reschedule-preset--15m" },
  { label: "+1 hour", sub: "in 1h",    minutes: 60,     testId: "reschedule-preset--1h" },
  { label: "Tomorrow", sub: "morning", minutes: 24 * 60, testId: "reschedule-preset-tomorrow" },
] as const;

export function RescheduleReminderModal({
  rescheduleReminder,
  setRescheduleReminder,
  onSave,
}: RescheduleReminderModalProps) {
  const now = new Date();
  const activePresetIdx = PRESETS.findIndex((p) => {
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
            {PRESETS.map((preset, idx) => (
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
                <span className={`text-[10px] font-medium ${activePresetIdx === idx ? "text-violet-200" : "text-slate-400"}`}>
                  {preset.sub}
                </span>
              </button>
            ))}
          </div>

          {/* Custom date/time input */}
          <div className="mt-4">
            <div className="relative flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5">
              <div className="flex-1">
                <p className="text-[14px] font-semibold text-slate-700">
                  {rescheduleReminder.value
                    ? new Date(rescheduleReminder.value.replace("T", " ")).toLocaleString(undefined, {
                        month: "short", day: "numeric", year: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })
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
              onClick={onSave}
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
}
