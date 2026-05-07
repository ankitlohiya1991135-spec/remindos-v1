"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * Mounted in the root layout. Pings `/api/track/heartbeat` every minute
 * while the tab is visible, so admins can see aggregate usage time per
 * user. Stores only timing — never content, paths, or actions. No-op
 * for signed-out visitors.
 */
export function HeartbeatPinger() {
  const { isSignedIn, isLoaded } = useUser();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    let cancelled = false;
    const send = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void fetch("/api/track/heartbeat", {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    };

    // Fire one immediately so a short visit still registers, then every minute.
    send();
    const interval = setInterval(send, HEARTBEAT_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") send();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isLoaded, isSignedIn]);

  return null;
}
