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

export const appLifecycleOperationKinds = [
  "install",
  "activate",
  "reconfigure",
  "disable",
  "enable",
  "remove",
  "dispose_data",
] as const;
export type AppLifecycleOperationKind = (typeof appLifecycleOperationKinds)[number];

export const appLifecycleOperationStates = [
  "running",
  "completed",
  "failed",
  "compensating",
  /** Terminal and operator-visible: compensation itself could not finish. */
  "compensation_failed",
] as const;
export type AppLifecycleOperationState = (typeof appLifecycleOperationStates)[number];

export const appSagaStepIds = [
  "create_records",
  "persist_grants_and_connections",
  "validate",
  "provision_runtime",
  "stage_contributions",
  "run_safe_tests",
  "apply_configuration",
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
   * data that was disposed, or a state the abandonment path already corrects.
   */
  readonly compensation: "reverse" | "skip";
}

/**
 * Setup and activation are two operations, not one.
 *
 * `install` durably records what the operator approved — the installation row, the grant
 * set, the effective configuration — and touches nothing outside the database. The
 * operator then binds the connections the release requires, which is only possible
 * against an installation that exists. `activate` is the operation that provisions,
 * stages, tests, and goes live, and it refuses while a required slot is unbound. A
 * generated secret can therefore be minted and handed over exactly once before anything
 * depends on it, instead of a first install having to claim a slot is bound when nothing
 * has been stored for it.
 */
export const appSagaSteps: Readonly<Record<AppLifecycleOperationKind, readonly AppSagaStep[]>> = {
  install: [
    { id: "create_records", enters: "planned", compensation: "skip" },
    { id: "persist_grants_and_connections", enters: null, compensation: "reverse" },
  ],
  activate: [
    { id: "provision_runtime", enters: "provisioning", compensation: "reverse" },
    { id: "stage_contributions", enters: "staged", compensation: "reverse" },
    { id: "run_safe_tests", enters: "testing", compensation: "skip" },
    { id: "mark_ready", enters: "ready", compensation: "skip" },
    { id: "activate", enters: "active", compensation: "skip" },
  ],
  // FR-021b: a configuration change re-stages and re-tests before it becomes the
  // installation's answer to what it does. Nothing before the last step writes the new
  // configuration, so an abandoned reconfigure leaves the stored one untouched and the
  // next successful operation re-stages from it; there is nothing to reverse.
  reconfigure: [
    { id: "validate", enters: null, compensation: "skip" },
    { id: "stage_contributions", enters: null, compensation: "skip" },
    { id: "run_safe_tests", enters: null, compensation: "skip" },
    { id: "apply_configuration", enters: null, compensation: "skip" },
  ],
  disable: [
    { id: "stop_runtime", enters: null, compensation: "skip" },
    { id: "mark_disabled", enters: "disabled", compensation: "skip" },
  ],
  // Re-enabling is a return to the state the installation already tested its way into,
  // so it does not walk the staging path again.
  enable: [
    { id: "provision_runtime", enters: null, compensation: "reverse" },
    { id: "activate", enters: "active", compensation: "skip" },
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

/**
 * What a resumed compensation still owes. `compensationCursor` names the last compensator
 * that completed, so an interrupted rollback continues rather than replaying reversals it
 * already ran.
 */
export const remainingAppSagaCompensationSteps = (
  kind: AppLifecycleOperationKind,
  cursor: AppSagaStepId | null,
  compensationCursor: AppSagaStepId | null,
): readonly AppSagaStep[] => {
  const plan = appSagaCompensationPlan(kind, cursor);
  if (compensationCursor === null) return plan;
  const index = plan.findIndex((step) => step.id === compensationCursor);
  return index < 0 ? plan : plan.slice(index + 1);
};

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
