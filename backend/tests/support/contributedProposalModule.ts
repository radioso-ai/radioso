import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ApplicationModule } from "../../src/app/composition/index.js";
import type {
  CopilotContributedProposalAdapter,
  CopilotProposalAdapterContribution,
} from "../../src/modules/operatorCopilot/public.js";

/**
 * An application module that owns a target type Ray has never heard of: an alert threshold a
 * workspace sets on its own usage. Applying one creates an alert, so it is create-shaped — the shape
 * an interrupted apply would duplicate if it were retried.
 */
export const ALERT_THRESHOLD_TARGET_TYPE = "alert_threshold";
export const ALERT_THRESHOLD_TOOL = "propose_alert_threshold";
export const ALERT_THRESHOLD_PRESENTATION = { label: "usage alerts", dashboardPath: "/settings?settingsTab=usage" } as const;

const inputSchema = z.object({
  threshold: z.number().int().positive().max(1_000_000),
  rationale: z.string().max(500).optional(),
}).strict();
const changeSchema = z.object({ threshold: z.number().int().positive() }).strict();

export interface AlertThresholdState {
  /** Every alert an apply created, in order. */
  readonly created: Array<{ id: string; workspaceId: string; threshold: number }>;
  /** Every change the adapter was handed, so a test can see it never receives Ray's card fields. */
  readonly changesSeen: unknown[];
}

export const createAlertThresholdAdapter = (
  state: AlertThresholdState,
  overrides: Partial<CopilotContributedProposalAdapter<z.infer<typeof inputSchema>>> = {},
): CopilotContributedProposalAdapter<z.infer<typeof inputSchema>> => ({
  targetType: ALERT_THRESHOLD_TARGET_TYPE,
  permissions: { read: ["workspace.settings.read"], manage: ["workspace.settings.manage"] },
  async draft(input) {
    return {
      targetRef: {},
      change: { threshold: input.threshold },
      // A create addresses no stored row, so its token is constant.
      versionToken: "create",
      targetLabel: `Alert at ${input.threshold} answers`,
      summary: `Alert the workspace once it uses ${input.threshold} answers this month.${input.rationale ? ` ${input.rationale}` : ""}`,
      presentation: ALERT_THRESHOLD_PRESENTATION,
    };
  },
  async readVersionToken(_workspaceId, _targetRef, change) {
    state.changesSeen.push(change);
    return "create";
  },
  async preview(_workspaceId, _targetRef, change) {
    state.changesSeen.push(change);
    return { current: null, proposed: changeSchema.parse(change) };
  },
  async applyIfVersionMatches(workspaceId, _targetRef, change) {
    state.changesSeen.push(change);
    const alert = { id: randomUUID(), workspaceId, threshold: changeSchema.parse(change).threshold };
    state.created.push(alert);
    return { outcome: "applied", appliedRef: { alertId: alert.id } };
  },
  // A retry cannot tell whether the first attempt created an alert, so it must never run.
  canRetryAfterInterruptedApply: () => false,
  ...overrides,
});

export const createAlertThresholdContribution = (
  state: AlertThresholdState,
  overrides: { moduleId?: string; adapter?: Partial<CopilotContributedProposalAdapter<z.infer<typeof inputSchema>>> } = {},
): CopilotProposalAdapterContribution<z.infer<typeof inputSchema>> => ({
  moduleId: overrides.moduleId ?? "test-alerts",
  adapter: createAlertThresholdAdapter(state, overrides.adapter),
  tool: {
    name: ALERT_THRESHOLD_TOOL,
    description: "Propose an answer-count threshold at which the workspace is alerted, for the operator to review and apply.",
    uiLabel: "Drafting an alert threshold",
    inputSchema,
    capabilityProvenance: { rayOnly: { reason: "A test module's proposal, drafted and stored by Ray for operator review." } },
  },
});

export const createAlertThresholdState = (): AlertThresholdState => ({ created: [], changesSeen: [] });

/** The module as a deployment would register it. */
export const createAlertThresholdModule = (
  state: AlertThresholdState,
  overrides: Parameters<typeof createAlertThresholdContribution>[1] = {},
): ApplicationModule => ({
  id: overrides.moduleId ?? "test-alerts",
  register(context) {
    context.registerCopilotProposalAdapter(() => createAlertThresholdContribution(state, overrides));
  },
});
