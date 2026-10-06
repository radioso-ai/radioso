import { sql, type Selectable } from "kysely";

// The handoff module owns the held-reply machine, its record and its store ports; this repository is
// their Postgres adapter, reading every state rule from the machine rather than restating it.
import type {
  HeldReplyInsert,
  HeldReplyReadStore,
  HeldReplySupersedeScope,
  HeldReplyWriteStore,
} from "../../modules/handoff/heldReplies/heldReplyService.js";
import {
  heldReplyEventSources,
  heldReplyEventTarget,
  type HeldReplyEvent,
  type HeldReplyRecord,
  type HeldReplyTransition,
  type HeldReplyTurnFacts,
  type SupersedeReason,
} from "../../modules/handoff/heldReplies/heldReplyState.js";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";

type HeldReplyRow = Selectable<DB["held_replies"]>;
type ListQuery = Parameters<HeldReplyReadStore["listOpen"]>[1];

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const asCode = (value: unknown): string => (typeof value === "string" ? value : "unknown");

const readSuppressedEffects = (value: unknown): { skillName: string }[] =>
  (Array.isArray(value) ? value : []).flatMap((effect) => {
    const skillName = asObject(effect).skillName;
    return typeof skillName === "string" ? [{ skillName }] : [];
  });

/** `turn_facts` holds the facts but the suppressed effects, which have their own column. */
const readFacts = (turnFacts: unknown, suppressedEffects: unknown): HeldReplyTurnFacts => {
  const facts = asObject(turnFacts);
  const handoff = asObject(facts.handoff);
  return {
    outcome: asCode(facts.outcome),
    grounding: asCode(facts.grounding),
    coverage: asCode(facts.coverage),
    handoff: handoff.requested === true ? { requested: true, reason: asCode(handoff.reason) } : { requested: false },
    suppressedEffects: readSuppressedEffects(suppressedEffects),
    citationCount: typeof facts.citationCount === "number" ? facts.citationCount : 0,
  };
};

const storedFacts = (facts: HeldReplyTurnFacts): Record<string, unknown> => ({
  outcome: facts.outcome,
  grounding: facts.grounding,
  coverage: facts.coverage,
  handoff: facts.handoff,
  citationCount: facts.citationCount,
});

const mapHeldReply = (row: HeldReplyRow): HeldReplyRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  agentId: row.agent_id,
  // The table's CHECKs hold the enum columns to the machine's vocabulary.
  state: row.state as HeldReplyRecord["state"],
  releaseKind: row.release_kind as HeldReplyRecord["releaseKind"],
  reviewRef: row.review_ref,
  answersMessageId: row.answers_message_id,
  ownershipVersion: row.ownership_version,
  // Bound together, by the policy CHECK.
  policy: row.policy_ref !== null && row.policy_version !== null ? { ref: row.policy_ref, version: row.policy_version } : null,
  holdReason: row.hold_reason,
  facts: readFacts(row.turn_facts, row.suppressed_effects),
  draft: { text: row.draft_text, presentation: asObject(row.draft_presentation) },
  editedText: row.edited_text,
  editorUserId: row.editor_user_id,
  releaserUserId: row.releaser_user_id,
  discardedByUserId: row.discarded_by_user_id,
  releasedMessageId: row.released_message_id,
  supersededReason: row.superseded_reason as HeldReplyRecord["supersededReason"],
  attentionClearedAt: row.attention_cleared_at,
  attentionClearedReason: row.attention_cleared_reason as HeldReplyRecord["attentionClearedReason"],
  decidedAt: row.decided_at,
  createdAt: row.created_at,
});

/** The columns a transition writes: its state and release kind, and attention closed when it closes it. */
const transitionColumns = (target: HeldReplyTransition) => ({
  state: target.state,
  release_kind: target.releaseKind,
  attention_cleared_at: target.attentionCleared === null ? null : currentTimestamp(),
  attention_cleared_reason: target.attentionCleared,
  updated_at: currentTimestamp(),
});

/** The columns a decision writes: a transition that takes the draft out of the live states. */
const decisionColumns = (event: HeldReplyEvent) => ({
  ...transitionColumns(heldReplyEventTarget(event)),
  decided_at: currentTimestamp(),
});

/**
 * `held_replies`: one live draft per conversation and one held reply per review ref, enforced by the
 * partial unique indexes. Every write is conditional on the states the machine lets its event move a
 * held reply out of, so a write that lost a race matches nothing. Construct it on the transaction of
 * the unit of work that writes, so a held reply commits with the locks and the change it stands on.
 */
export class HeldReplyRepository implements HeldReplyWriteStore, HeldReplyReadStore, HeldReplySupersedeScope {
  constructor(private readonly db: Db) {}

  async insert(input: HeldReplyInsert): Promise<{ record: HeldReplyRecord; created: boolean }> {
    const { born } = input;
    const row = await this.db
      .insertInto("held_replies")
      .values({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        agent_id: input.agentId,
        review_ref: input.reviewRef,
        answers_message_id: input.answersMessageId,
        ownership_version: input.ownershipVersion,
        policy_ref: input.policy?.ref ?? null,
        policy_version: input.policy?.version ?? null,
        hold_reason: input.holdReason,
        turn_facts: toJsonb(storedFacts(input.facts)),
        suppressed_effects: toJsonb(input.facts.suppressedEffects.map(({ skillName }) => ({ skillName }))),
        draft_text: input.draft.text,
        draft_presentation: toJsonb(input.draft.presentation),
        ...(born.state === "superseded"
          ? { ...decisionColumns({ kind: "supersede", reason: born.reason }), superseded_reason: born.reason }
          : { state: born.state }),
      })
      .onConflict((oc) => oc.columns(["conversation_id", "review_ref"]).where("review_ref", "is not", null).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row) {
      return { record: mapHeldReply(row), created: true };
    }
    // Only a review ref already held on the conversation skips the insert.
    const existing = input.reviewRef === null ? null : await this.findByReviewRef(input.conversationId, input.reviewRef);
    if (!existing) {
      throw new Error("Held reply insert skipped without a held review ref");
    }
    return { record: existing, created: false };
  }

  async findById(heldReplyId: string): Promise<HeldReplyRecord | null> {
    const row = await this.db
      .selectFrom("held_replies")
      .selectAll()
      .where("id", "=", heldReplyId)
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  async findInConversation(conversationId: string, heldReplyId: string): Promise<HeldReplyRecord | null> {
    const row = await this.db
      .selectFrom("held_replies")
      .selectAll()
      .where("id", "=", heldReplyId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  async latestCustomerMessageId(conversationId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("messages")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("role", "=", "user")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  async release(input: Parameters<HeldReplyWriteStore["release"]>[0]): Promise<HeldReplyRecord | null> {
    const edited = input.editedText !== null;
    const row = await this.db
      .updateTable("held_replies")
      .set({
        ...decisionColumns({ kind: "release", edited }),
        edited_text: input.editedText,
        editor_user_id: edited ? input.userId : null,
        releaser_user_id: input.userId,
      })
      .where("id", "=", input.id)
      .where("conversation_id", "=", input.conversationId)
      .where("state", "in", heldReplyEventSources("release"))
      .where("ownership_version", "=", input.ownershipVersion)
      .returningAll()
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  async attachReleasedMessage(heldReplyId: string, messageId: string): Promise<HeldReplyRecord> {
    const row = await this.db
      .updateTable("held_replies")
      .set({ released_message_id: messageId, updated_at: currentTimestamp() })
      .where("id", "=", heldReplyId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapHeldReply(row);
  }

  async discard(input: Parameters<HeldReplyWriteStore["discard"]>[0]): Promise<HeldReplyRecord | null> {
    const row = await this.db
      .updateTable("held_replies")
      .set({ ...decisionColumns({ kind: "discard" }), discarded_by_user_id: input.userId })
      .where("id", "=", input.id)
      .where("conversation_id", "=", input.conversationId)
      .where("state", "in", heldReplyEventSources("discard"))
      .returningAll()
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  async materialize(input: Parameters<HeldReplyWriteStore["materialize"]>[0]): Promise<HeldReplyRecord | null> {
    const event = { kind: "materialize", authorized: input.authorized } as const;
    const target = heldReplyEventTarget(event);
    const row = await this.db
      .updateTable("held_replies")
      // An authorized send is decided; one returned to a teammate is pending again, undecided.
      .set({
        ...(input.authorized ? decisionColumns(event) : transitionColumns(target)),
        ...(target.holdReason === undefined ? {} : { hold_reason: target.holdReason }),
      })
      .where("id", "=", input.id)
      .where("conversation_id", "=", input.conversationId)
      .where("state", "in", heldReplyEventSources("materialize"))
      .returningAll()
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  async supersedePendingForConversation(conversationId: string, reason: Exclude<SupersedeReason, "policy_changed">): Promise<number> {
    const result = await this.supersede(reason, "conversation_id", conversationId).executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async supersedePendingForPolicy(policyRef: string, reason: "policy_changed"): Promise<string[]> {
    const rows = await this.supersede(reason, "policy_ref", policyRef).returning("conversation_id").execute();
    return rows.map((row) => row.conversation_id);
  }

  async holdLiveForPolicy(policyRef: string, policyVersion: number, reason: "policy_changed"): Promise<{ returned: number; rebound: number }> {
    // The pending drafts first, so the queued sends returned to pending after them are not re-bound twice.
    const rebound = await this.db
      .updateTable("held_replies")
      .set({ ...transitionColumns(heldReplyEventTarget({ kind: "rebind_policy" })), policy_version: policyVersion })
      .where("policy_ref", "=", policyRef)
      .where("state", "in", heldReplyEventSources("rebind_policy"))
      .executeTakeFirst();
    const target = heldReplyEventTarget({ kind: "return_queued", reason });
    // Returned undecided, as an unauthorized materialization returns it: its attention opens.
    const returned = await this.db
      .updateTable("held_replies")
      .set({
        ...transitionColumns(target),
        ...(target.holdReason === undefined ? {} : { hold_reason: target.holdReason }),
        policy_version: policyVersion,
      })
      .where("policy_ref", "=", policyRef)
      .where("state", "in", heldReplyEventSources("return_queued"))
      .executeTakeFirst();
    return { returned: Number(returned.numUpdatedRows), rebound: Number(rebound.numUpdatedRows) };
  }

  async clearDiscardedAttention(conversationId: string, reason: "operator_reply" | "takeover"): Promise<number> {
    const result = await this.db
      .updateTable("held_replies")
      .set(transitionColumns(heldReplyEventTarget({ kind: "clear_discarded_attention", reason })))
      .where("conversation_id", "=", conversationId)
      .where("state", "in", heldReplyEventSources("clear_discarded_attention"))
      .where("attention_cleared_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async findByReviewRef(conversationId: string, reviewRef: string): Promise<HeldReplyRecord | null> {
    const row = await this.db
      .selectFrom("held_replies")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("review_ref", "=", reviewRef)
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  async current(workspaceId: string, conversationId: string): Promise<HeldReplyRecord | null> {
    const row = await this.db
      .selectFrom("held_replies")
      .selectAll()
      .where("conversation_id", "=", conversationId)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? mapHeldReply(row) : null;
  }

  listOpen(workspaceId: string, query: ListQuery): Promise<HeldReplyRecord[]> {
    return this.list(workspaceId, query, { attentionOpenOnly: true });
  }

  listAll(workspaceId: string, query: ListQuery): Promise<HeldReplyRecord[]> {
    return this.list(workspaceId, query, { attentionOpenOnly: false });
  }

  /**
   * The conversations with a live draft bound to the policy, in id order: what a change to the
   * policy locks before the policy itself (`app/composition/conversationLockOrder.ts`).
   */
  async liveConversationIds(policyRef: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("held_replies")
      .select("conversation_id")
      .distinct()
      .where("policy_ref", "=", policyRef)
      .where("state", "in", heldReplyEventSources("supersede"))
      .orderBy("conversation_id")
      .execute();
    return rows.map((row) => row.conversation_id);
  }

  /**
   * The automatic sends still queued since before `before` under policies with the prefix, oldest
   * first: the rollback sweep returns them to a teammate where `auto` is not run.
   */
  async listQueuedAutoBefore(input: { policyRefPrefix: string; before: Date; limit: number }): Promise<string[]> {
    const rows = await this.db
      .selectFrom("held_replies")
      .select("id")
      .where("state", "=", "queued_auto")
      .where(sql<boolean>`starts_with(policy_ref, ${input.policyRefPrefix})`)
      .where("created_at", "<", input.before)
      .orderBy("created_at")
      .orderBy("id")
      .limit(input.limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /** The supersede of the live drafts matching `column`, for the caller to run. */
  private supersede(reason: SupersedeReason, column: "conversation_id" | "policy_ref", value: string) {
    return this.db
      .updateTable("held_replies")
      .set({ ...decisionColumns({ kind: "supersede", reason }), superseded_reason: reason })
      .where(column, "=", value)
      .where("state", "in", heldReplyEventSources("supersede"));
  }

  private async list(
    workspaceId: string,
    query: ListQuery,
    options: { attentionOpenOnly: boolean },
  ): Promise<HeldReplyRecord[]> {
    let select = this.db
      .selectFrom("held_replies")
      .selectAll()
      .where("workspace_id", "=", workspaceId);
    if (options.attentionOpenOnly) {
      // `isHeldReplyAttentionOpen`, spelled as the attention index's predicate so the read uses it.
      select = select.where("attention_cleared_at", "is", null).where("state", "<>", "queued_auto");
    }
    const { agentId, after } = query;
    if (agentId !== undefined) {
      select = select.where("agent_id", "=", agentId);
    }
    if (after) {
      select = select.where((eb) => eb.or([
        eb("created_at", "<", after.createdAt),
        eb.and([eb("created_at", "=", after.createdAt), eb("id", "<", after.id)]),
      ]));
    }
    const rows = await select
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(query.limit)
      .execute();
    return rows.map(mapHeldReply);
  }
}
