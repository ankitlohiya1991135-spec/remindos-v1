/**
 * Cross-component event channel for "this Clerk user's metadata just moved
 * server-side". Fired by every admin endpoint caller in the client (role
 * change, deactivate, bulk-deactivate, hard-delete, reset-chat, etc.).
 *
 * Listeners (drawer admin gate, admin user list, future panels) re-pull
 * their data on receipt so the UI updates without a hard refresh.
 *
 * Lives in `lib/` instead of inside an admin component so layout-level
 * code (AppDrawer) can subscribe without dragging the admin component
 * graph into the root layout's bundle.
 */

export const USER_METADATA_CHANGED_EVENT = "app:user-metadata-changed";

export interface UserMetadataChangedDetail {
  /** Clerk userId of the user whose metadata changed. */
  targetUserId: string;
}

/** Helper to fire the event from anywhere on the client. */
export function broadcastUserMetadataChanged(targetUserId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<UserMetadataChangedDetail>(USER_METADATA_CHANGED_EVENT, {
      detail: { targetUserId },
    }),
  );
}
