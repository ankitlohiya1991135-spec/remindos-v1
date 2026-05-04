"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

export interface WalkthroughStep {
  id: string;
  line1: string;
  line2: string;
  targetSelectors: string[];
  nextLabel: string;
}

interface WalkthroughOverlayProps {
  open: boolean;
  step: WalkthroughStep;
  stepIndex: number;
  stepCount: number;
  onNext: () => void;
  onClose: () => void;
}

export function WalkthroughOverlay({
  open,
  step,
  stepIndex,
  stepCount,
  onNext,
  onClose,
}: WalkthroughOverlayProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true))
      );
    } else {
      setVisible(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isLastStep = stepIndex >= stepCount - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="walkthrough-title"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{
        backgroundColor: `rgba(15, 10, 30, ${visible ? 0.85 : 0})`,
        transition: "background-color 300ms ease",
      }}
    >
      {/* Card */}
      <div
        className="relative w-full max-w-sm rounded-3xl bg-white px-7 py-8 shadow-2xl dark:bg-slate-900"
        style={{
          transform: visible
            ? "scale(1) translateY(0)"
            : "scale(0.95) translateY(16px)",
          opacity: visible ? 1 : 0,
          transition: "transform 300ms ease, opacity 300ms ease",
        }}
      >
        {/* Logo */}
        <div className="mb-5 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#7c3aed_0%,#06b6d4_100%)] shadow-[0_12px_30px_-12px_rgba(124,58,237,0.7)]">
            <Image
              src="/logo-remindos.svg"
              alt="RemindOS"
              width={28}
              height={28}
            />
          </div>
        </div>

        {/* Step label */}
        <p className="mb-1 text-center text-[10px] font-extrabold uppercase tracking-[0.2em] text-violet-500 dark:text-violet-400">
          Step {stepIndex + 1} of {stepCount}
        </p>

        {/* Title */}
        <h2
          id="walkthrough-title"
          className="text-center text-xl font-extrabold leading-snug text-slate-900 dark:text-slate-100"
        >
          {step.line1}
        </h2>

        {/* Description */}
        <p className="mt-3 text-center text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {step.line2}
        </p>

        {/* Progress dots */}
        <div className="mt-6 flex items-center justify-center gap-1.5">
          {Array.from({ length: stepCount }).map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-300 ${
                i === stepIndex
                  ? "h-2 w-6 bg-violet-600"
                  : i < stepIndex
                    ? "h-2 w-2 bg-violet-300 dark:bg-violet-700"
                    : "h-2 w-2 bg-slate-200 dark:bg-slate-700"
              }`}
            />
          ))}
        </div>

        {/* Buttons */}
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-2xl border border-slate-200 py-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 active:scale-[0.97] dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={onNext}
            className="flex-1 rounded-2xl bg-violet-600 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-violet-500 active:scale-[0.97]"
          >
            {isLastStep ? "Done ✓" : `${step.nextLabel} →`}
          </button>
        </div>
      </div>
    </div>
  );
}
