# React Native (Expo) Migration Blueprint

Migrating Personal Life OS from a Next.js web app to a native Android (and later iOS)
app using **React Native + Expo**, while preserving the database, auth, AI, and
business logic.

> **TL;DR** — The data layer (Convex), auth (Clerk), AI (NVIDIA NIM), and the entire
> `@repo/reminder` logic package carry over. The **UI is rebuilt** in React Native, and
> **push notifications are re-architected** (web-push → Expo/FCM, including Convex-side
> changes). This is a real project measured in weeks, not a config switch — but RN keeps
> you in TypeScript with the same vendors, which is why it beats Flutter for this stack.

---

## 0. Evidence gathered (why this plan is grounded)

| Check | Result |
|---|---|
| `@repo/reminder` browser/Node API usage | **Zero** — clean pure TS (1,380 lines). Reuses verbatim in RN. |
| Convex + Clerk on Expo | **Officially supported** via `ConvexProviderWithClerk` + `@clerk/clerk-expo`. |
| Route weight | `chat` = 3,210 lines (heavy NIM orchestration). Most others thin. Admin routes (~1,800 lines) are **web-only**. |
| Auth mechanism | `@clerk/nextjs` = session **cookies**; `@clerk/clerk-expo` = Bearer **tokens**. This changes the backend boundary (see §1). |

---

## 1. THE decision everything hangs on: the backend boundary

A phone cannot run Next.js API routes. So the first fork dictates everything downstream:

### Option A — Keep Next.js on Vercel as a headless API
Mobile app calls the existing `app/api/*` routes over HTTPS.
- ✅ Reuses all route logic (especially the 3,210-line chat orchestration) as-is.
- ❌ **Every route's auth must change.** Routes today call Clerk's `auth()` which reads a
  *cookie*. Expo sends a *Bearer token*. Each mobile-facing route must switch to verifying
  the token (`clerkClient.authenticateRequest` / `verifyToken`).
- Faster to a working app **if** routes are thin wrappers.

### Option B — Port route logic into Convex functions/actions
Mobile (and eventually web) calls Convex directly via `ConvexProviderWithClerk`.
- ✅ **Auth is nearly free** — Convex already verifies Clerk JWTs through your existing
  `packages/db/convex/auth.config.ts`. No per-route token plumbing.
- ✅ Cleaner end state; real-time subscriptions for free on mobile.
- ❌ More upfront work porting the heavy chat route into a Convex action.

### Recommendation: **Hybrid, decided per-route by weight**
- **Thin CRUD routes** (reminders, tasks — mostly Convex wrappers already) → **Option B**.
  Call Convex directly from mobile. Auth comes free.
- **The chat route** (3,210 lines of NIM orchestration) → **Option A** initially. Keep it on
  Vercel, add token-based auth, let mobile call it over HTTPS. Port to a Convex `action`
  later if desired. This avoids a massive rewrite on day one.
- **Admin routes** → **stay web-only**. End users don't get admin on mobile.

---

## 2. What carries over vs. what is rebuilt

| Stays the same | Rebuilt / re-architected |
|---|---|
| ✅ Convex DB + schema | ❌ Entire UI (dashboard, chat, reminder cards, overlays) → RN components |
| ✅ Clerk (vendor) — via `clerk-expo` | ❌ Push: web-push/VAPID → Expo Notifications / FCM (**touches Convex too**, see §3) |
| ✅ NVIDIA NIM AI (stays server-side) | ❌ Auth *integration* (cookies → Bearer tokens) |
| ✅ `@repo/reminder` (verbatim) | ❌ Tailwind classes → NativeWind or RN StyleSheet |
| ✅ Shared TS types across web + mobile | ❌ Service worker (`public/sw.js`) — N/A on native |

---

## 3. Push notifications = a BACKEND rewrite, not a client swap

This is the most underestimated piece. Web-push assumptions are baked into Convex:

- `packages/db/convex/pushSubscriptions.ts` — stores **web-push subscription objects**.
  Must change schema to store **Expo push tokens** (or FCM tokens).
- `packages/db/convex/pushCron.ts` / `notifications.ts` — the send path uses the `web-push`
  library + VAPID. Must call the **Expo Push API** (or FCM) instead.
- Client — request native notification permission, register the device token, store it.

Scope this as **Convex schema + cron + client**, across both web and mobile if you want a
single notification system.

---

## 4. Mobile API surface (smaller than the ~40 routes suggest)

Only these are mobile-facing:

- **Reminders**: list/create (`reminders/route.ts`), `[id]` edit/delete, sharing (`share/*`),
  inbox.
- **Tasks**: `tasks/route.ts`, `tasks/[id]`.
- **Chat**: `chat/route.ts` (+ `chat/history`).
- **Push**: `push/subscribe` (reworked per §3), server-side crons stay on Vercel/Convex.
- **Misc**: `notifications`, `users/directory`.

**Explicitly out of scope for mobile:** all of `app/api/admin/*` (~1,800 lines) — user
management, broadcasts, audit, cost overview. These remain web-only.

---

## 5. Phased plan (de-risk auth + data before committing to the rest)

### Phase 0 — Workspace scaffold
- `npx create-expo-app apps/mobile` inside the pnpm/Turbo monorepo.
- Wire workspace deps: `@repo/reminder`, `@repo/db` (Convex generated API + types).
- Add `apps/mobile` to `turbo.json` pipelines.

### Phase 1 — Auth + data layer (the linchpin) ⚠️
- Install `@clerk/clerk-expo`, `convex`, `expo-secure-store` (Clerk token cache).
- Provider hierarchy in `app/_layout.tsx`:
  `ClerkProvider` → `ClerkLoaded` → `ConvexProviderWithClerk` → app.
- Verify with `useConvexAuth()` that Convex is authenticated.
- **Known quirk to handle:** signing out then back in can leave Convex unauthenticated;
  fix by remounting `ConvexProviderWithClerk` keyed on Clerk `sessionId`
  (convex-js issue #156).
- ✅ **Exit criteria:** login works; an authenticated Convex query returns the user's data.

### Phase 2 — One real read path
- Reminders list, read **directly from Convex** (Option B), rendered in RN.
- Proves the data layer end-to-end and validates the hybrid approach with real evidence.

### Phase 3 — Decide A vs B for writes, with evidence
- Now that Phases 1–2 are working, lock the per-route boundary from §1.
- Implement reminder/task **writes** via Convex (B).

### Phase 4 — Chat (hardest)
- Keep `chat/route.ts` on Vercel (Option A); add Bearer-token auth verification.
- Mobile calls it over HTTPS, reusing `@repo/reminder` for client-side intent helpers.
- Reuse all the existing `AgentAction` / `applyAction` types from the shared package.

### Phase 5 — Push (FCM) — see §3
- Convex schema + send path + client registration.

### Phase 6 — UI parity, feature by feature
- Dashboard, reminder cards, overlays, briefings — rebuilt in RN (NativeWind for styling
  familiarity). Port the interactive reminder chat-card work last, on top of stable data.

### Phase 7 — Ship
- EAS Build → Play Store internal testing → production.

---

## 6. Risks / watch-items

1. **Chat route size (3,210 lines).** Keep on Vercel initially; don't try to port to Convex
   in v1.
2. **Clerk sign-out/in remount quirk** on Expo (Phase 1) — known, solvable.
3. **Push schema migration** affects existing web users if unified — plan a migration.
4. **Tailwind → NativeWind** is approximate, not 1:1; some layouts need rework.
5. **Two clients, one backend** during transition — version the API or keep Convex
   functions backward-compatible.

---

## 7. Vendor support summary (confirmed)

- Convex Clerk guide: https://docs.convex.dev/auth/clerk
- Convex + Clerk on Expo: https://stack.convex.dev/user-authentication-with-clerk-and-convex
- Clerk Convex integration: https://clerk.com/docs/guides/development/integrations/databases/convex
- Using Clerk in Expo: https://docs.expo.dev/guides/using-clerk/
- Known remount issue: https://github.com/get-convex/convex-js/issues/156
