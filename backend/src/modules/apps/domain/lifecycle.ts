import { AppsError } from "./errors.js";

export const appInstallationStates = [
  "planned",
  "provisioning",
  "staged",
  "testing",
  "ready",
  "active",
  "disabled",
  "failed",
  "removing",
  "removed",
] as const;
export type AppInstallationState = (typeof appInstallationStates)[number];

export const appLifecycleOperationKinds = ["install", "disable", "enable", "remove", "dispose_data"] as const;
export type AppLifecycleOperationKind = (typeof appLifecycleOperationKinds)[number];

export const appLifecycleOperationStates = ["running", "completed", "failed", "compensating"] as const;
export type AppLifecycleOperationState = (typeof appLifecycleOperationStates)[number];

export const appSagaStepIds = [
  "create_records",
  "persist_grants_and_connections",
  "provision_runtime",
  "stage_contributions",
  "run_safe_tests",
  "mark_ready",
  "activate",
  "stop_runtime",
  "mark_disabled",
  "revoke_grants",
  "mark_connections_for_deletion",
  "detach_contributions",
  "dispose_data",
  "mark_removed",
] as const;
export type AppSagaStepId = (typeof appSagaStepIds)[number];

export interface AppSagaStep {
  readonly id: AppSagaStepId;
  /** The installation state this step commits, or `null` when it changes no state. */
  readonly enters: AppInstallationState | null;
  /**
   * `reverse` means the step has a compensator that is safe to run after a later
   * failure. `skip` means reversal is either meaningless or would guess at an external
   * effect that already happened — a safe test that ran, a process that was stopped,
   * data that was disposed.
   */
  readonly compensation: "reverse" | "skip";
}

export const appSagaSteps: Readonly<Record<AppLifecycleOperationKind, readonly AppSagaStep[]>> = {
  install: [
    { id: "create_records", enters: "planned", compensation: "reverse" },
    { id: "persist_grants_and_connections", enters: null, compensation: "reverse" },
    { id: "provision_runtime", enters: "provisioning", compensation: "reverse" },
    { id: "stage_contributions", enters: "staged", compensation: "reverse" },
    { id: "run_safe_tests", enters: "testing", compensation: "skip" },
    { id: "mark_ready", enters: "ready", compensation: "reverse" },
    { id: "activate", enters: "active", compensation: "reverse" },
  ],
  disable: [
    { id: "stop_runtime", enters: null, compensation: "skip" },
    { id: "mark_disabled", enters: "disabled", compensation: "skip" },
  ],
  // Re-enabling is a return to the state the installation already tested its way into,
  // so it does not walk the staging path again.
  enable: [
    { id: "provision_runtime", enters: null, compensation: "reverse" },
    { id: "activate", enters: "active", compensation: "reverse" },
  ],
  remove: [
    { id: "revoke_grants", enters: "removing", compensation: "skip" },
    { id: "mark_connections_for_deletion", enters: null, compensation: "skip" },
    { id: "stop_runtime", enters: null, compensation: "skip" },
    { id: "detach_contributions", enters: null, compensation: "skip" },
    { id: "dispose_data", enters: null, compensation: "skip" },
    { id: "mark_removed", enters: "removed", compensation: "skip" },
  ],
  dispose_data: [
    { id: "dispose_data", enters: null, compensation: "skip" },
  ],
};

const stepIndex = (kind: AppLifecycleOperationKind, cursor: AppSagaStepId | null): number =>
  cursor === null ? -1 : appSagaSteps[kind].findIndex((step) => step.id === cursor);

/** The steps a resumed operation still owes, read from its durable cursor. */
export const remainingAppSagaSteps = (
  kind: AppLifecycleOperationKind,
  cursor: AppSagaStepId | null,
): readonly AppSagaStep[] => appSagaSteps[kind].slice(stepIndex(kind, cursor) + 1);

/**
 * Compensation for what actually committed, newest first, skipping every step whose
 * effect cannot be safely reversed.
 */
export const appSagaCompensationPlan = (
  kind: AppLifecycleOperationKind,
  cursor: AppSagaStepId | null,
): readonly AppSagaStep[] => appSagaSteps[kind]
  .slice(0, stepIndex(kind, cursor) + 1)
  .filter((step) => step.compensation === "reverse")
  .reverse();

const allowedTransitions: Readonly<Record<AppInstallationState, readonly AppInstallationState[]>> = {
  planned: ["provisioning", "failed", "removing"],
  provisioning: ["staged", "failed", "removing"],
  staged: ["testing", "failed", "removing"],
  testing: ["ready", "failed", "removing"],
  ready: ["active", "failed", "removing"],
  active: ["disabled", "failed", "removing"],
  disabled: ["provisioning", "active", "failed", "removing"],
  failed: ["provisioning", "disabled", "removing"],
  removing: ["removed", "failed"],
  removed: [],
};

export const canTransitionAppInstallation = (
  from: AppInstallationState,
  to: AppInstallationState,
): boolean => from === to || allowedTransitions[from].includes(to);

export const assertAppInstallationTransition = (
  from: AppInstallationState,
  to: AppInstallationState,
): void => {
  if (!canTransitionAppInstallation(from, to)) {
    throw new AppsError("invalid_transition", `An installation cannot move from ${from} to ${to}.`, { from, to });
  }
};
