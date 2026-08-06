import { createHash } from "node:crypto";

import type { EnqueueActionRequestInput } from "../../db/repositories/actionRequestRepository.js";
import type { AgentSkillRepositoryPort } from "../agentSkills/public.js";
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

const payloadHash = (payload: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

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
    const payload = {
      message: message.trim(),
      ...(isNonEmptyString(email) ? { email: email.trim() } : {}),
    };
    // Dedupe a re-enqueue of the *same* contact request (e.g. a retried turn)
    // without collapsing distinct submissions: scope the key to the conversation
    // and the payload, mirroring the legacy action-step idempotency. Falling back
    // to the constant `notify:${agentId}:${skillName}` (the prior behavior) made
    // every contact request after the first for an agent collide and silently drop.
    const idempotencyScope = conversationId ?? agentId;
    const result = await this.options.outbox.enqueue({
      type: CONTACT_SEND_ACTION_TYPE,
      payload,
      workspaceId,
      conversationId,
      idempotencyKey: `notify:${idempotencyScope}:${invocation.skill.name}:${payloadHash(payload)}`,
      // Routing provenance, not domain data — kept off the payload so the drain-time
      // delivery resolver can prefer this named skill's own config (see
      // ConfiguredContactDeliveryResolver) without inferring it from an idempotency key.
      skillName: invocation.skill.name,
    });

    return settled("delivered", {
      skillName: skill.skillName,
      enqueued: true,
      duplicate: result.duplicate,
    });
  }
}
