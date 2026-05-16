"use client";

/**
 * ChatBubbleShell
 *
 * Wraps a chat message bubble with:
 *   - Desktop (md+): a hover chevron that opens a Reply / Edit dropdown menu
 *   - Mobile: swipe-right gesture triggers Reply; long-press opens a bottom action sheet
 *
 * Extracted from dashboard-workspace.tsx for independent maintainability.
 */

import { useRef, useState, type ReactNode } from "react";

export interface ChatBubbleShellProps {
  children: ReactNode;
  onReply: () => void;
  onEdit?: () => void;
  showEdit: boolean;
  actionAlign?: "start" | "center" | "end";
  showActionsAlways?: boolean;
  desktopHoverMenu?: boolean;
  onLongPressEdit?: () => void;
}

export function ChatBubbleShell({
  children,
  onReply,
  onEdit,
  showEdit,
  actionAlign = "end",
  showActionsAlways = false,
  desktopHoverMenu = false,
  onLongPressEdit,
}: ChatBubbleShellProps) {
  const touchStart = useRef({ x: 0, y: 0 });
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipeReleasing, setSwipeReleasing] = useState(false);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const justify =
    actionAlign === "center"
      ? "justify-center"
      : actionAlign === "start"
        ? "justify-start"
        : "justify-end";

  const runReplySwipeAnimation = () => {
    setSwipeReleasing(true);
    setSwipeOffset(96);
    window.setTimeout(() => {
      setSwipeOffset(0);
    }, 110);
    window.setTimeout(() => {
      setSwipeReleasing(false);
    }, 240);
  };

  return (
    <div
      className="group/msg relative min-w-0 w-full max-w-full"
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (!t) return;
        touchStart.current = { x: t.clientX, y: t.clientY };
        setSwipeReleasing(false);
        if (swipeOffset !== 0) setSwipeOffset(0);
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          longPressTimer.current = null;
          setMobileMenuOpen(true);
        }, 470);
      }}
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - touchStart.current.x;
        const dy = t.clientY - touchStart.current.y;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          clearLongPress();
        }

        if (dx > 0 && Math.abs(dy) < 72 && dx > Math.abs(dy)) {
          setSwipeReleasing(false);
          setSwipeOffset(Math.min(dx, 96));
        } else if (swipeOffset !== 0) {
          setSwipeOffset(0);
        }
      }}
      onTouchEnd={(e) => {
        clearLongPress();
        const t = e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - touchStart.current.x;
        const dy = t.clientY - touchStart.current.y;
        if (dx > 84 && Math.abs(dy) < 64) {
          runReplySwipeAnimation();
          onReply();
          return;
        }
        if (swipeOffset > 0) {
          setSwipeReleasing(true);
          setSwipeOffset(0);
          window.setTimeout(() => {
            setSwipeReleasing(false);
          }, 180);
        }
      }}
      onTouchCancel={() => {
        clearLongPress();
        if (swipeOffset > 0) {
          setSwipeReleasing(true);
          setSwipeOffset(0);
          window.setTimeout(() => {
            setSwipeReleasing(false);
          }, 180);
        }
      }}
    >
      {desktopHoverMenu ? (
        <div
          className="pointer-events-none absolute -right-1 -top-1 z-30 hidden pb-10 pl-10 pt-1 md:block"
          onMouseEnter={() => setDesktopMenuOpen(true)}
          onMouseLeave={() => setDesktopMenuOpen(false)}
        >
          <div
            className={`pointer-events-auto transition-opacity duration-150 ${
              desktopMenuOpen
                ? "opacity-100"
                : "opacity-0 group-hover/msg:opacity-100"
            }`}
          >
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDesktopMenuOpen((o) => !o);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-300/50 bg-white/95 text-slate-600 shadow-sm backdrop-blur-sm hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-200 dark:hover:bg-slate-700"
                aria-expanded={desktopMenuOpen}
                aria-haspopup="menu"
                aria-label="Message options"
              >
                <span className="text-base leading-none" aria-hidden>
                  ⌄
                </span>
              </button>
              {desktopMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-40 mt-1 min-w-[9rem] rounded-xl border border-slate-200 bg-white py-1 text-xs font-medium text-slate-800 shadow-lg dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700"
                    onClick={() => {
                      setDesktopMenuOpen(false);
                      onReply();
                    }}
                  >
                    Reply
                  </button>
                  {showEdit && onEdit ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-700"
                      onClick={() => {
                        setDesktopMenuOpen(false);
                        onEdit();
                      }}
                    >
                      Edit message
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {mobileMenuOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-slate-950/20 p-3 md:hidden"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="w-full rounded-2xl border border-slate-200 bg-white p-2 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                onReply();
              }}
              className="block w-full rounded-xl px-3 py-3 text-left text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              Reply
            </button>
            {showEdit && (onEdit || onLongPressEdit) ? (
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  (onEdit ?? onLongPressEdit)?.();
                }}
                className="block w-full rounded-xl px-3 py-3 text-left text-sm font-medium text-violet-700 hover:bg-violet-50"
              >
                Edit
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-2 z-0 flex items-center md:hidden">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-white shadow-md"
            style={{
              opacity: Math.min(1, swipeOffset / 34),
              transform: `scale(${0.7 + Math.min(0.3, (swipeOffset / 96) * 0.3)})`,
            }}
            aria-hidden
          >
            ↩
          </span>
        </div>
        <div
          className={`relative z-10 ${swipeReleasing ? "transition-transform duration-200 ease-out" : ""}`}
          style={{ transform: `translateX(${swipeOffset}px)` }}
        >
          {children}
        </div>
      </div>

      <div
        className={`mt-1 flex flex-wrap gap-2 ${justify} transition-opacity ${
          desktopHoverMenu
            ? "hidden"
            : showActionsAlways
              ? "opacity-100"
              : "opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100"
        }`}
      >
        <button
          type="button"
          className="rounded-full border border-slate-200 bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-slate-500 shadow-sm transition hover:border-slate-300 hover:text-slate-900"
          onClick={onReply}
        >
          Reply
        </button>
        {showEdit && onEdit ? (
          <button
            type="button"
            className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700 shadow-sm transition hover:border-violet-300 hover:bg-violet-100"
            onClick={onEdit}
          >
            Edit
          </button>
        ) : null}
      </div>
    </div>
  );
}
