import type {
  VisitorObservedFacts,
  VisitorRepositoryPort,
} from "../../../db/repositories/visitorRepository.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

interface ResolveVisitorForConversationInput {
  workspaceId: string;
  anonymousSessionId: string | null;
  verifiedCustomerId: string | null;
  observed: VisitorObservedFacts;
}

interface ResolveVisitorForConversationResult {
  visitorId: string;
}

interface AttachVerifiedIdentityInput {
  conversationId: string;
  workspaceId: string;
  anonymousSessionId: string | null;
  verifiedCustomerId: string;
}

type AttachVerifiedIdentityOutcome = "upgraded" | "moved_existing" | "moved_new" | "unchanged";

interface AttachVerifiedIdentityResult {
  outcome: AttachVerifiedIdentityOutcome;
}

/**
 * Narrow port the chat module depends on. Only the two operations a turn ever
 * needs — never the full {@link VisitorRepositoryPort}.
 */
export interface VisitorResolverPort {
  resolveForConversation(input: ResolveVisitorForConversationInput): Promise<ResolveVisitorForConversationResult>;
  attachVerifiedIdentity(input: AttachVerifiedIdentityInput): Promise<AttachVerifiedIdentityResult>;
}

/**
 * Identity-resolution rules for the `visitors` entity (spec 1277, FR-003/FR-004):
 * a verified id beats an anonymous id, an anonymous visitor upgrades in place the
 * first time it verifies, and a later, different verified id moves the
 * conversation to that identity's own row without touching — or re-attaching —
 * the anonymous id. The repository holds no rule; every branch below is the
 * exhaustive description of what "resolve" and "attach" mean.
 */
export class VisitorResolver implements VisitorResolverPort {
  constructor(
    private readonly repository: VisitorRepositoryPort,
    private readonly metrics?: Pick<MetricsRegistry, "incrementCounter"> | null,
  ) {}

  async resolveForConversation(
    input: ResolveVisitorForConversationInput,
  ): Promise<ResolveVisitorForConversationResult> {
    if (input.verifiedCustomerId) {
      const verified = await this.repository.findByVerifiedCustomerId(input.workspaceId, input.verifiedCustomerId);
      if (verified) {
        await this.repository.recordObservation(verified.id, input.observed);
        return { visitorId: verified.id };
      }
    }

    if (input.anonymousSessionId) {
      const anon = await this.repository.findByAnonymousSessionId(input.workspaceId, input.anonymousSessionId);
      if (anon) {
        if (input.verifiedCustomerId && !anon.verifiedCustomerId) {
          await this.repository.upgradeToVerified(anon.id, input.verifiedCustomerId);
        }
        await this.repository.recordObservation(anon.id, input.observed);
        return { visitorId: anon.id };
      }
    }

    // Neither key resolved to an existing row: insert. Both known keys ride on
    // the new row when both are fresh; see insertOrGet's conflict-target note
    // for the (rare, undetected) race this leaves between a fresh anonymous id
    // and a verified id that lands concurrently on its own row.
    const { record, inserted } = await this.repository.insertOrGet({
      workspaceId: input.workspaceId,
      anonymousSessionId: input.anonymousSessionId,
      verifiedCustomerId: input.verifiedCustomerId,
      observed: input.observed,
    });
    if (!inserted) {
      // Lost an insert race (User Story 2 scenario 4): the row that won already
      // carries this conversation's first-ever observation, so this is a second,
      // legitimate conversation against it.
      await this.repository.recordObservation(record.id, input.observed);
    }
    return { visitorId: record.id };
  }

  async attachVerifiedIdentity(input: AttachVerifiedIdentityInput): Promise<AttachVerifiedIdentityResult> {
    const anonRow = input.anonymousSessionId
      ? await this.repository.findByAnonymousSessionId(input.workspaceId, input.anonymousSessionId)
      : null;
    const verifiedRow = await this.repository.findByVerifiedCustomerId(input.workspaceId, input.verifiedCustomerId);

    if (verifiedRow && anonRow && verifiedRow.id === anonRow.id) {
      return { outcome: "unchanged" };
    }

    if (!verifiedRow && anonRow && !anonRow.verifiedCustomerId) {
      await this.repository.upgradeToVerified(anonRow.id, input.verifiedCustomerId);
      this.recordOutcome("upgraded");
      return { outcome: "upgraded" };
    }

    // Every remaining branch moves this conversation to a row for
    // `verifiedCustomerId` — existing or freshly inserted — and never touches
    // `anonRow`'s own verified id (never re-attach, User Story 2 scenario 3).
    const outcome: "moved_existing" | "moved_new" = verifiedRow ? "moved_existing" : "moved_new";
    const targetVisitorId = verifiedRow
      ? verifiedRow.id
      : (await this.repository.insertOrGet({
          workspaceId: input.workspaceId,
          verifiedCustomerId: input.verifiedCustomerId,
          observed: { country: null, language: null, userAgent: null },
        })).record.id;

    await this.repository.moveConversation({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      fromVisitorId: anonRow?.id ?? null,
      toVisitorId: targetVisitorId,
    });
    this.recordOutcome(outcome);
    return { outcome };
  }

  private recordOutcome(outcome: "upgraded" | "moved_existing" | "moved_new"): void {
    this.metrics?.incrementCounter("visitor_identity_attached_total", {
      help: "Visitor identity attachments by outcome when a conversation's turn verifies a customer id.",
      labels: { outcome },
    });
  }
}
