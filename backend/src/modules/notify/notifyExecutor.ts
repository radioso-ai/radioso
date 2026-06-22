import type { EnqueueActionRequestInput } from "../../db/repositories/actionRequestRepository.js";
import type { AgentSkillRepositoryPort } from "../agentSkills/repository.js";
import { CONTACT_SEND_ACTION_TYPE } from "../chat/contracts/index.js";
import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
} from "../skills/public.js";

export const NOTIFY_SKILLS_ADAPTER = "notify";

export interface NotifyOutboxPort {
  enqueue(input: EnqueueActionRequestInput): Promise<{ id: string; duplicate: boolean }>;
}

const settled = (status: "delivered" | "failed", outputs: Record<string, unknown> = {}): SkillDispatchResult => ({
  disposition: "settled",
  outcome: { status, outputs } as SkillOutcome,
});

const stringContext = (invocation: SkillInvocation, key: string): string | null =>
  typeof invocation.context?.[key] === "string" ? invocation.context[key] : null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export class NotifyExecutor implements SkillExecutorPort {
  constructor(private readonly options: {
    skills: Pick<AgentSkillRepositoryPort, "findByName">;
    outbox: NotifyOutboxPort;
  }) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const workspaceId = stringContext(invocation, "workspaceId");
    const agentId = stringContext(invocation, "agentId");
    if (!workspaceId || !agentId) {
      return settled("failed", { reason: "context_missing" });
    }

    const skill = await this.options.skills.findByName(workspaceId, agentId, invocation.skill.name);
    if (!skill || skill.kind !== "notify" || !skill.enabled) {
      return settled("failed", { reason: "skill_not_found" });
    }

    const message = invocation.collected?.message;
    if (!isNonEmptyString(message)) {
      return settled("failed", { reason: "missing_input", missingInputs: ["message"] });
    }

    const email = invocation.collected?.email;
    const conversationId = stringContext(invocation, "conversationId");
    const requestId = stringContext(invocation, "requestId")
      ?? stringContext(invocation, "idempotencyKey")
      ?? `notify:${agentId}:${invocation.skill.name}`;
    const result = await this.options.outbox.enqueue({
      type: CONTACT_SEND_ACTION_TYPE,
      payload: {
        message: message.trim(),
        ...(isNonEmptyString(email) ? { email: email.trim() } : {}),
      },
      workspaceId,
      conversationId,
      idempotencyKey: `notify:${requestId}:${invocation.skill.name}`,
    });

    return settled("delivered", {
      skillName: skill.skillName,
      enqueued: true,
      duplicate: result.duplicate,
    });
  }
}
