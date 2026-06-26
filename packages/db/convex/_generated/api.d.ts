/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as authz from "../authz.js";
import type * as chat from "../chat.js";
import type * as crons from "../crons.js";
import type * as notifications from "../notifications.js";
import type * as pushCron from "../pushCron.js";
import type * as pushNotificationLogs from "../pushNotificationLogs.js";
import type * as pushSubscriptions from "../pushSubscriptions.js";
import type * as reminderSharing from "../reminderSharing.js";
import type * as reminders from "../reminders.js";
import type * as tasks from "../tasks.js";
import type * as userEvents from "../userEvents.js";
import type * as userProfiles from "../userProfiles.js";
import type * as userSessions from "../userSessions.js";
import type * as userWiki from "../userWiki.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  authz: typeof authz;
  chat: typeof chat;
  crons: typeof crons;
  notifications: typeof notifications;
  pushCron: typeof pushCron;
  pushNotificationLogs: typeof pushNotificationLogs;
  pushSubscriptions: typeof pushSubscriptions;
  reminderSharing: typeof reminderSharing;
  reminders: typeof reminders;
  tasks: typeof tasks;
  userEvents: typeof userEvents;
  userProfiles: typeof userProfiles;
  userSessions: typeof userSessions;
  userWiki: typeof userWiki;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
