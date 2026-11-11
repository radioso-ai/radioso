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

/**
 * A second module, owning an update-shaped target: one answer limit per deployment, versioned.
 * Applying compares the draft's token with the stored version and bumps it in the same write, so a
 * retry after an interrupted apply that took effect reads as stale. That is what lets it answer
 * true to `canRetryAfterInterruptedApply`.
 */
export const ALERT_LIMIT_TARGET_TYPE = "alert_limit";
export const ALERT_LIMIT_TOOL = "propose_alert_limit";

export interface AlertLimitState {
  limit: number | null;
  version: number;
  /** Every write that took effect, whoever made it. */
  writes: number;
}

export const createAlertLimitState = (): AlertLimitState => ({ limit: null, version: 1, writes: 0 });

/** The limit write the module owns: a compare-and-set on the version, which it bumps. */
export const writeAlertLimit = (state: AlertLimitState, limit: number, expectedVersionToken: string): boolean => {
  if (expectedVersionToken !== `v${state.version}`) return false;
  state.limit = limit;
  state.version += 1;
  state.writes += 1;
  return true;
};

const limitInputSchema = z.object({ limit: z.number().int().positive().max(1_000_000) }).strict();
const limitChangeSchema = z.object({ limit: z.number().int().positive() }).strict();

const createAlertLimitContribution = (state: AlertLimitState): CopilotProposalAdapterContribution<z.infer<typeof limitInputSchema>> => ({
  moduleId: "test-alert-limits",
  adapter: {
    targetType: ALERT_LIMIT_TARGET_TYPE,
    permissions: { read: ["workspace.settings.read"], manage: ["workspace.settings.manage"] },
    async draft(input) {
      return {
        targetRef: {},
        change: { limit: input.limit },
        versionToken: `v${state.version}`,
        targetLabel: `Answer limit ${input.limit}`,
        summary: `Stop answering after ${input.limit} answers this month.`,
        presentation: ALERT_THRESHOLD_PRESENTATION,
      };
    },
    async readVersionToken() {
      return `v${state.version}`;
    },
    async preview(_workspaceId, _targetRef, change) {
      return { current: { limit: state.limit }, proposed: limitChangeSchema.parse(change) };
    },
    async applyIfVersionMatches(_workspaceId, _targetRef, change, versionToken) {
      return writeAlertLimit(state, limitChangeSchema.parse(change).limit, versionToken)
        ? { outcome: "applied", appliedRef: { version: state.version } }
        : { outcome: "stale", reason: "The answer limit changed since this was drafted." };
    },
    canRetryAfterInterruptedApply: () => true,
  },
  tool: {
    name: ALERT_LIMIT_TOOL,
    description: "Propose the monthly answer limit, for the operator to review and apply.",
    uiLabel: "Drafting an answer limit",
    inputSchema: limitInputSchema,
    capabilityProvenance: { rayOnly: { reason: "A test module's proposal, drafted and stored by Ray for operator review." } },
  },
});

export const createAlertLimitModule = (state: AlertLimitState): ApplicationModule => ({
  id: "test-alert-limits",
  register(context) {
    context.registerCopilotProposalAdapter(createAlertLimitContribution(state));
  },
});
