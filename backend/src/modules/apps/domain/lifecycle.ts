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
  "open_candidate",
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
  // installation's answer to what it does. The proposal is durable from `open_candidate`
  // onwards, but it is a candidate — the configuration the installation is running is
  // untouched until `apply_configuration`, and a failure anywhere after `open_candidate`
  // discards the candidate and leaves the working installation exactly as it was.
  reconfigure: [
    { id: "validate", enters: null, compensation: "skip" },
    { id: "open_candidate", enters: null, compensation: "reverse" },
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

/**
 * The installation states each command may be issued from.
 *
 * A command is checked against this while its operation is claimed, before any port is
 * called. Without it, `activate` on an already-active installation provisions a second
 * runtime and only then discovers that `active -> provisioning` is not a transition, and
 * `disable` on a `planned` installation deprovisions something that was never provisioned.
 * A refusal here costs nothing; a refusal three steps in costs a compensation.
 */
const appCommandSourceStates: Readonly<
  Record<AppLifecycleOperationKind, readonly AppInstallationState[]>
> = {
  install: ["planned"],
  activate: ["planned"],
  disable: ["active"],
  enable: ["disabled"],
  reconfigure: ["planned", "active", "disabled"],
  // Removal is also the repair path, so it accepts the states a failed operation leaves
  // behind — including an installation already part-way through a removal that stopped.
  remove: ["planned", "active", "disabled", "failed", "removing"],
  dispose_data: ["removing", "removed"],
};

export const assertAppCommandSourceState = (
  kind: AppLifecycleOperationKind,
  state: AppInstallationState,
): void => {
  if (appCommandSourceStates[kind].includes(state)) return;
  throw new AppsError(
    "invalid_transition",
    `A ${kind} command cannot be issued against an installation in ${state}.`,
    { kind, state },
  );
};

/**
 * The edges back to `planned` are what a rolled-back activation travels. An activation
 * that provisioned and then hit an unavailable provider is a failed *attempt*, not a
 * broken installation: once its compensators have run, nothing of it survives, so the
 * installation returns to the state the operator started from and can be activated again.
 * `failed` is reserved for the case a rollback could not finish, which needs a person.
 */
const allowedTransitions: Readonly<Record<AppInstallationState, readonly AppInstallationState[]>> = {
  planned: ["provisioning", "failed", "removing"],
  provisioning: ["staged", "planned", "disabled", "failed", "removing"],
  staged: ["testing", "planned", "disabled", "failed", "removing"],
  testing: ["ready", "planned", "disabled", "failed", "removing"],
  ready: ["active", "planned", "disabled", "failed", "removing"],
  active: ["disabled", "failed", "removing"],
  disabled: ["provisioning", "active", "failed", "removing"],
  failed: ["provisioning", "planned", "disabled", "removing"],
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
