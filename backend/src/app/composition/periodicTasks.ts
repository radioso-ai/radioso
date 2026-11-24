import { contributedPeriodicTasks, type ApplicationPeriodicTaskHandle } from "./applicationModule.js";
import { conversationRetentionPeriodicTask, createConversationRetentionSweep } from "./conversationRetention.js";
import { identityNoncePrunePeriodicTask } from "./identityNoncePrune.js";

type PeriodicTaskEntry = { id: string; intervalMs: number; handle: ApplicationPeriodicTaskHandle };

/**
 * Every periodic task a deployment runs, by id: the built-in ones every deployment needs, then those
 * its application modules contribute. The worker's poll loop and its Cloud Scheduler task route run
 * the same list.
 */
export const buildPeriodicTaskEntries = (input: {
  retention: Parameters<typeof createConversationRetentionSweep>[0];
  identityNonces: Parameters<typeof identityNoncePrunePeriodicTask>[0];
  voiceRecordingErasureRecovery: PeriodicTaskEntry;
  workspaceEventDelivery: PeriodicTaskEntry;
  websiteRecrawl: PeriodicTaskEntry;
  contributed: {
    registrations: Parameters<typeof contributedPeriodicTasks>[0];
    context: Parameters<typeof contributedPeriodicTasks>[1];
  };
}): PeriodicTaskEntry[] => [
  // Every deployment enforces the retention its workspaces set, through the erasure.
  conversationRetentionPeriodicTask(createConversationRetentionSweep(input.retention)),
  // Recordings a deletion left pending with no job working on them are queued again.
  input.voiceRecordingErasureRecovery,
  // Single-use nonces of verified visitor identities are deleted once their window has passed.
  identityNoncePrunePeriodicTask(input.identityNonces),
  // Every event subscription with an event waiting is drained within a minute.
  input.workspaceEventDelivery,
  // Website sources with a recrawl cadence are queued for a crawl when their next recrawl is due.
  input.websiteRecrawl,
  ...contributedPeriodicTasks(input.contributed.registrations, input.contributed.context),
];
