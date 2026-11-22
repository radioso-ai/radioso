/**
 * How often a website source recrawls itself, and the arithmetic of when it next does. Pure: the
 * sweep, the cadence setting, and the plan ceiling all read these rules, and none of them owns them.
 */
export const recrawlCadences = ["off", "daily", "weekly"] as const;
export type RecrawlCadence = (typeof recrawlCadences)[number];
/** A cadence that runs. A plan's fastest cadence is always one of these. */
export type ActiveRecrawlCadence = Exclude<RecrawlCadence, "off">;

/** Who started a crawl: the operator (dashboard, API, Ray) or the recrawl sweep. */
export const crawlTriggers = ["manual", "scheduled"] as const;
export type CrawlTrigger = (typeof crawlTriggers)[number];

const DAY_MS = 24 * 60 * 60 * 1_000;
const CADENCE_INTERVAL_MS: Readonly<Record<ActiveRecrawlCadence, number>> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

/** Spreads sources that share a cadence across an hour, so a sweep never queues them all at once. */
export const RECRAWL_JITTER_MAX_MS = 60 * 60 * 1_000;

export const recrawlJitterMs = (random: () => number = Math.random): number =>
  Math.min(Math.floor(random() * RECRAWL_JITTER_MAX_MS), RECRAWL_JITTER_MAX_MS - 1);

/** Whether a plan whose fastest cadence is `fastest` lets an operator choose `requested`. */
export const isRecrawlCadenceWithinPlan = (requested: RecrawlCadence, fastest: ActiveRecrawlCadence): boolean =>
  requested === "off" || CADENCE_INTERVAL_MS[requested] >= CADENCE_INTERVAL_MS[fastest];

/**
 * The cadence a source runs at: its stored choice, slowed to the plan's fastest. A workspace that
 * moves to a plan with a slower ceiling keeps its choice and runs at the ceiling.
 */
export function effectiveRecrawlCadence(stored: ActiveRecrawlCadence, fastest: ActiveRecrawlCadence): ActiveRecrawlCadence;
export function effectiveRecrawlCadence(stored: RecrawlCadence, fastest: ActiveRecrawlCadence): RecrawlCadence;
export function effectiveRecrawlCadence(stored: RecrawlCadence, fastest: ActiveRecrawlCadence): RecrawlCadence {
  return stored === "off" || isRecrawlCadenceWithinPlan(stored, fastest) ? stored : fastest;
}

/**
 * The fastest cadence the workspace's plan allows. Plans are an edition's knowledge, so this is
 * all the crawler sees of them; a deployment with no plans allows `daily`.
 */
export interface RecrawlPlanPort {
  fastestRecrawlCadence(input: { workspaceId: string }): Promise<ActiveRecrawlCadence>;
}

/** When a source whose cadence was just set first recrawls: one interval after its last sync, never before now. */
export const firstRecrawlAt = (input: {
  now: Date;
  lastSyncedAt: Date | null;
  cadence: RecrawlCadence;
  jitterMs: number;
}): Date | null => {
  if (input.cadence === "off") {
    return null;
  }
  const afterLastSync = input.lastSyncedAt ? input.lastSyncedAt.getTime() + CADENCE_INTERVAL_MS[input.cadence] : 0;
  return new Date(Math.max(input.now.getTime(), afterLastSync) + input.jitterMs);
};

/** When a source the sweep just queued recrawls again. */
export const nextRecrawlAfterRun = (input: { now: Date; cadence: ActiveRecrawlCadence; jitterMs: number }): Date =>
  new Date(input.now.getTime() + CADENCE_INTERVAL_MS[input.cadence] + input.jitterMs);
