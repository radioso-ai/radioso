import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
} from "../../skills/public.js";
import {
  enqueueSlackPostAction,
  slackPostIdempotencyKey,
  type SlackPostOutboxPort,
} from "../../slack/public.js";
import { slackSkillInputKeys, type SlackSkillDefinitionSummary, type SlackSkillInputKey, type SlackSkillOutcome } from "../domain.js";
import type { SlackSkillDefinitionRepositoryPort } from "../repository.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";

export const SLACK_SKILLS_ADAPTER = "slack-skills";

export interface SlackEscalationExecutorOptions {
  skills: Pick<SlackSkillDefinitionRepositoryPort, "findEnabledByName">;
  outbox: SlackPostOutboxPort;
}

const settled = (
  status: SlackSkillOutcome,
  outputs: Record<string, unknown> = {},
): SkillDispatchResult => ({
  disposition: "settled",
  outcome: { status, outputs } as SkillOutcome,
});

const failure = (code: string): SkillDispatchResult =>
  settled("failed", { reason: code });

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export class SlackEscalationExecutor implements SkillExecutorPort {
  constructor(private readonly options: SlackEscalationExecutorOptions) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    return traceOperation({
      name: "slack.skill.dispatch",
      attributes: { "slack.skill_name": invocation.skill.name },
      run: () => this.dispatchInner(invocation),
      resultAttributes: (result) => ({
        "slack.outcome": result.disposition === "settled" ? result.outcome.status : "deferred",
      }),
    });
  }

  private async dispatchInner(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const agentId = stringContext(invocation, "agentId");
    const workspaceId = stringContext(invocation, "workspaceId");
    const conversationId = stringContext(invocation, "conversationId");
    if (!agentId || !workspaceId) return failure("context_missing");

    const definition = await this.options.skills.findEnabledByName(workspaceId, agentId, invocation.skill.name);
    if (!definition) return failure("skill_not_found");

    setTraceAttributes({
      "slack.agent_id": agentId,
      "slack.workspace_id": workspaceId,
      "slack.installation_id": definition.installationId,
    });

    const input = buildRuntimeInput(definition, invocation.collected ?? {});
    const missing = missingInputs(input);
    if (missing.length > 0) {
      return settled("missing_input", { missingInputs: missing, skillName: definition.skillName });
    }

    const sourceId = idempotencySource(invocation, definition.skillName);
    const conversationRef = conversationId ?? sourceId;
    await enqueueSlackPostAction(this.options.outbox, {
      workspaceId,
      conversationId,
      idempotencyKey: slackPostIdempotencyKey({ kind: "routine_post", sourceId }),
      payload: {
        installationId: definition.installationId,
        channelId: String(input.channelId),
        text: String(input.text),
        ...(isNonEmptyString(input.threadTs) ? { threadTs: input.threadTs } : {}),
        conversationRef,
        kind: "routine_post",
      },
    });

    return settled("enqueued", {
      skillName: definition.skillName,
      installationId: definition.installationId,
      channelId: String(input.channelId),
    });
  }
}

const buildRuntimeInput = (
  definition: Pick<SlackSkillDefinitionSummary, "boundInputs" | "exposedInputs">,
  collected: Record<string, unknown>,
): Partial<Record<SlackSkillInputKey, unknown>> => {
  const input: Partial<Record<SlackSkillInputKey, unknown>> = {};
  for (const key of slackSkillInputKeys) {
    if (Object.prototype.hasOwnProperty.call(definition.boundInputs, key)) {
      input[key] = definition.boundInputs[key];
      continue;
    }
    const exposed = definition.exposedInputs[key];
    if (!exposed) continue;
    const collectedKey = exposed.slotBinding ?? key;
    if (Object.prototype.hasOwnProperty.call(collected, collectedKey)) {
      input[key] = collected[collectedKey];
    }
  }
  return input;
};

const missingInputs = (input: Partial<Record<SlackSkillInputKey, unknown>>): SlackSkillInputKey[] => {
  const missing: SlackSkillInputKey[] = [];
  if (!isNonEmptyString(input.channelId)) missing.push("channelId");
  if (!isNonEmptyString(input.text)) missing.push("text");
  return missing;
};

const stringContext = (invocation: SkillInvocation, key: string): string =>
  typeof invocation.context?.[key] === "string" ? invocation.context[key] : "";

const idempotencySource = (invocation: SkillInvocation, skillName: string): string => {
  const explicit = stringContext(invocation, "idempotencyKey") || stringContext(invocation, "requestId");
  if (explicit) return explicit;
  const sessionId = stringContext(invocation, "sessionId") || "unknown-session";
  const routineId = stringContext(invocation, "routineId") || "unknown-routine";
  const stepId = stringContext(invocation, "stepId") || "unknown-step";
  return `${sessionId}:${routineId}:${stepId}:${skillName}`;
};
