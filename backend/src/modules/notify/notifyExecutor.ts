import { createHash } from "node:crypto";

import type { TurnContext } from "@radioso/conversation-contract";

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

const isTurnContext = (value: unknown): value is TurnContext =>
  typeof value === "object" && value !== null && "inputEvent" in value;

/**
 * The persisted id of the inbound message that triggered this turn, when the
 * caller supplied one via `context.turn` — see the idempotency-key comment in
 * {@link NotifyExecutor.dispatch} for why this is preferred over content-
 * addressing the payload.
 */
const invocationMessageId = (invocation: SkillInvocation): string | null => {
  const turn = invocation.context?.turn;
  if (!isTurnContext(turn)) {
    return null;
  }
  const id = turn.inputEvent?.id;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
};

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
    // without collapsing distinct submissions. The routine dispatch path — the
    // only production caller, see RoutineSkillExecutorDispatcher — always threads
    // the originating TurnContext through as `context.turn`, so
    // `turn.inputEvent.id` (the persisted id of the inbound message that
    // triggered this turn) is a stable per-invocation identity: it repeats
    // across a retried dispatch of the same message but is unique per distinct
    // visitor submission, even when two submissions carry byte-identical
    // message+email. Prefer it over content-addressing the payload, which would
    // otherwise collapse two genuinely distinct requests in one conversation
    // into a single enqueue (the second silently reported `delivered` with
    // nothing sent).
    //
    // The payload hash stays in the key alongside the message id rather than
    // being replaced by it: the routine runner walks consecutive skill/action
    // steps within a SINGLE turn (see routineRunner's skill/action loop), so two
    // tool steps invoking this same skill share one `inputEvent.id`. Keyed on the
    // message id alone they would collide and silently drop the second. Together
    // the two discriminators cover every case — a retried dispatch repeats both
    // and dedupes; distinct submissions differ in the message id; distinct
    // payloads within one turn differ in the hash; and a genuinely identical
    // re-send within one turn is a duplicate that should collapse.
    //
    // When no turn is supplied (a caller that doesn't build one — none exists in
    // production today), the hash alone scopes the key to the conversation,
    // mirroring the legacy action-step idempotency. Falling back further to the
    // constant `notify:${agentId}:${skillName}` (an earlier version of this code)
    // made every contact request after the first for an agent collide and
    // silently drop.
    const idempotencyScope = conversationId ?? agentId;
    const messageId = invocationMessageId(invocation);
    const idempotencyDiscriminator = messageId
      ? `${messageId}:${payloadHash(payload)}`
      : payloadHash(payload);
    const result = await this.options.outbox.enqueue({
      type: CONTACT_SEND_ACTION_TYPE,
      payload,
      workspaceId,
      conversationId,
      idempotencyKey: `notify:${idempotencyScope}:${invocation.skill.name}:${idempotencyDiscriminator}`,
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
