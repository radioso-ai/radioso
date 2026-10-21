import type { AppDependencies } from "./types.js";

/** One thing a shutdown closes, named for the log line its failure writes. */
interface CloseStep {
  name: string;
  close(): Promise<void> | void;
}

/**
 * Runs every step in order, even after one fails. Each failure is logged with its step's name, and
 * once every step has run the first failure is rethrown, so the caller still sees a shutdown that
 * did not finish cleanly.
 */
export const closeInOrder = async (
  steps: readonly CloseStep[],
  logger: Pick<AppDependencies["logger"], "error">,
): Promise<void> => {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step.close();
    } catch (error) {
      logger.error({ err: error, step: step.name }, "Shutdown step failed");
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
};

/** What a composed application holds open past its last request, and the logger its shutdown reports to. */
export type ClosableDependencies = Pick<
  AppDependencies,
  | "realtimePublisherLifecycle"
  | "applicationModules"
  | "closeApprovalResumeEffectJournal"
  | "closeAbuseControlRepository"
  | "connectorRegistry"
  | "logger"
>;

/**
 * What `buildDependencies` opened, in the order every runtime shuts it down: the realtime publisher
 * (its Redis connection, when it has one), the application modules, the approval journal's
 * database, the abuse-control repository, then the connectors, whose shutdown is a no-op for a
 * connector that never started. The main database pool stays open for the caller, which ends it
 * or exits.
 */
export const dependencyCloseSteps = (dependencies: ClosableDependencies): CloseStep[] => [
  { name: "realtime publisher", close: () => dependencies.realtimePublisherLifecycle.shutdown() },
  { name: "application modules", close: () => dependencies.applicationModules.shutdownAll() },
  { name: "approval resume effect journal", close: () => dependencies.closeApprovalResumeEffectJournal() },
  { name: "abuse control repository", close: () => dependencies.closeAbuseControlRepository?.() },
  { name: "connectors", close: () => dependencies.connectorRegistry.shutdownAll() },
];

/** Closes what the composition opened (`dependencyCloseSteps`) with `closeInOrder`. */
export const closeDependencies = (dependencies: ClosableDependencies): Promise<void> =>
  closeInOrder(dependencyCloseSteps(dependencies), dependencies.logger);
