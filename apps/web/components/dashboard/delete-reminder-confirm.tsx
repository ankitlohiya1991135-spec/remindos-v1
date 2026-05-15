"use client";

/**
 * DeleteReminderConfirm
 *
 * Confirmation dialog before permanently deleting a reminder.
 * Extracted from dashboard-workspace.tsx.
 */

export interface DeleteReminderConfirmProps {
  id: string;
  title: string;
  onConfirm: (id: string) => void;
  onDismiss: () => void;
}

export function DeleteReminderConfirm({ id, title, onConfirm, onDismiss }: DeleteReminderConfirmProps) {
  return (
    <div
      className="fixed inset-0 z-[54] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onClick={onDismiss}
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
            &ldquo;{title}&rdquo; will be permanently deleted. This cannot be undone.
          </p>
        </div>
        <div className="grid gap-2 px-5 pb-8">
          <button
            type="button"
            onClick={() => onConfirm(id)}
            className="w-full rounded-2xl bg-rose-500 py-3.5 text-[14px] font-bold text-white transition hover:bg-rose-400"
            data-testid="reminder-delete-confirm"
          >
            Delete Reminder
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="w-full py-3 text-[14px] font-semibold text-slate-500"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
