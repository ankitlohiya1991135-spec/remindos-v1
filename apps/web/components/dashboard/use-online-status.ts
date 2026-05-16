"use client";

/**
 * use-online-status
 *
 * Returns the browser's current online/offline state and re-renders the
 * consuming component whenever connectivity changes.
 *
 * Uses `navigator.onLine` for the initial value and listens to the
 * `online` / `offline` window events for subsequent changes.
 * Falls back to `true` on environments where `navigator` is unavailable
 * (e.g. SSR) so the app always starts in an "online" state.
 */

import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine;
  });

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    // Sync in case the value changed between SSR and mount
    setIsOnline(navigator.onLine);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return isOnline;
}
