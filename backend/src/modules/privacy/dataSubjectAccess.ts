import type { AuditEventInput } from "../audit/contracts/index.js";
import type {
  DataSubjectDataExporter,
  DataSubjectExportRecord,
  DataSubjectIdentity,
  DataSubjectIdentityFinder,
  DataSubjectIdentityKind,
  DataSubjectReach,
} from "../../shared/domain/dataSubjectAccess.js";
import { AppError, badRequest } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { ConversationErasure, ConversationErasureActor } from "./conversationErasure.js";

/** The export format's name and version. A change to its shape is a new version. */
export const DATA_SUBJECT_EXPORT_FORMAT = "radioso.data_subject_export";
export const DATA_SUBJECT_EXPORT_FORMAT_VERSION = 1;

/**
 * The most conversations one export or erasure may reach. An export is built in memory and an
 * erasure runs one transaction per conversation, both inside one request. Erasing a conversation
 * of 20 messages took 44 ms on a local Postgres, so 200 take about 9 s: a database twenty times
 * slower still answers well inside the 300 s request limit, and the export stays a few megabytes.
 * A larger request is split by identity.
 */
export const DATA_SUBJECT_MAX_CONVERSATIONS = 200;

/** An identity a lookup found, with what an operator needs to decide whether it is the subject's. */
export interface DataSubjectIdentityCandidate {
  identity: DataSubjectIdentity;
  channel: string;
  label: string;
  conversationCount: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

/** One of the subject's conversations, as an operator reviews it before export or erasure. */
export interface DataSubjectConversation {
  id: string;
  channel: string | null;
  title: string | null;
  startedAt: Date;
  lastActivityAt: Date;
  messageCount: number;
}

/** The subject's conversations by id, for the operator's review. */
export interface DataSubjectConversationDirectory {
  list(input: { workspaceId: string; conversationIds: readonly string[] }): Promise<readonly DataSubjectConversation[]>;
}

export interface DataSubjectExportDocument {
  format: typeof DATA_SUBJECT_EXPORT_FORMAT;
  formatVersion: typeof DATA_SUBJECT_EXPORT_FORMAT_VERSION;
  exportedAt: string;
  workspaceId: string;
  identities: readonly DataSubjectIdentity[];
  /** Every registered section, keyed by name; a section with nothing for the subject is empty. */
  sections: Record<string, readonly DataSubjectExportRecord[]>;
}

/** What a subject's erasure removed, and whether it got through everything the identities reach. */
export interface DataSubjectErasureReceipt {
  visitorCount: number;
  conversationCount: number;
  messageCount: number;
  complete: boolean;
}

/**
 * A data subject request's operations, each over the identities an operator confirmed: find the
 * subject, review their conversations, export what is held about them, and erase it.
 */
export interface DataSubjectAccess {
  lookup(input: { workspaceId: string; query: string; actor: ConversationErasureActor }): Promise<DataSubjectIdentityCandidate[]>;
  listConversations(input: { workspaceId: string; identities: readonly DataSubjectIdentity[] }): Promise<DataSubjectConversation[]>;
  export(input: { workspaceId: string; identities: readonly DataSubjectIdentity[]; actor: ConversationErasureActor }): Promise<DataSubjectExportDocument>;
  erase(input: { workspaceId: string; identities: readonly DataSubjectIdentity[]; actor: ConversationErasureActor }): Promise<DataSubjectErasureReceipt>;
}

/** One read of the subject's data: every module's finders and exporters, bound to one snapshot. */
export interface DataSubjectReadScope {
  finders: readonly DataSubjectIdentityFinder[];
  exporters: readonly DataSubjectDataExporter[];
  conversations: DataSubjectConversationDirectory;
}

export interface DataSubjectReadUnitOfWork {
  run<T>(work: (scope: DataSubjectReadScope) => Promise<T>): Promise<T>;
}

interface DataSubjectAccessDependencies {
  reads: DataSubjectReadUnitOfWork;
  erasure: Pick<ConversationErasure, "eraseConversation" | "eraseVisitor">;
  audit: { record(event: AuditEventInput): Promise<void> };
  now?: () => Date;
  /** {@link DATA_SUBJECT_MAX_CONVERSATIONS} in a deployment. */
  maxConversations?: number;
  /** Logs why an erasure stopped, with ids and counts. */
  logger?: Pick<AppLogger, "warn">;
}

/**
 * How an audit event names identities: by kind and the ids of the records they are made of, never
 * by a key, which can be the person's own address and would outlive their erasure in the event.
 */
interface IdentityRecords {
  kind: DataSubjectIdentityKind;
  recordIds: readonly string[];
}

/** What the confirmed identities reach, and the records each kind of them resolved to. */
interface ResolvedIdentities {
  reach: DataSubjectReach;
  identities: IdentityRecords[];
}

const isNotFound = (error: unknown): boolean => error instanceof AppError && error.statusCode === 404;

const mergeReaches = (reaches: readonly DataSubjectReach[]): DataSubjectReach => {
  const unique = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    conversationIds: unique(reaches.flatMap((reach) => reach.conversationIds)),
    visitorIds: unique(reaches.flatMap((reach) => reach.visitorIds)),
    verifiedCustomerIds: unique(reaches.flatMap((reach) => reach.verifiedCustomerIds)),
  };
};

/**
 * Finds a data subject, reads what Radioso holds about them, and erases it: the use case behind an
 * access, portability or erasure request. A lookup returns candidate identities and merges none;
 * every later step takes the identities the operator confirmed. Lookup and export each record one
 * audit event with ids and counts; erasure leaves the record to each erasure it runs.
 */
export class DataSubjectAccessService implements DataSubjectAccess {
  private readonly now: () => Date;
  private readonly maxConversations: number;

  constructor(private readonly deps: DataSubjectAccessDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.maxConversations = deps.maxConversations ?? DATA_SUBJECT_MAX_CONVERSATIONS;
  }

  async lookup(input: { workspaceId: string; query: string; actor: ConversationErasureActor }): Promise<DataSubjectIdentityCandidate[]> {
    const query = input.query.trim();
    const { candidates, references } = await this.deps.reads.run(async ({ finders }) => {
      const found: DataSubjectIdentityCandidate[] = [];
      const refs: IdentityRecords[] = [];
      for (const finder of finders) {
        for (const match of await finder.find({ workspaceId: input.workspaceId, query })) {
          const identity = { kind: finder.kind, key: match.key };
          found.push({
            identity,
            channel: finder.channel,
            label: match.label,
            conversationCount: match.conversationCount,
            firstSeenAt: match.firstSeenAt,
            lastSeenAt: match.lastSeenAt,
          });
          refs.push({ kind: finder.kind, recordIds: match.recordIds });
        }
      }
      return { candidates: found, references: refs };
    });
    await this.record(input, "data_subject.looked_up", "success", {
      identities: references,
      identityCount: candidates.length,
      conversationCount: candidates.reduce((total, candidate) => total + candidate.conversationCount, 0),
    });
    return candidates;
  }

  async listConversations(input: { workspaceId: string; identities: readonly DataSubjectIdentity[] }): Promise<DataSubjectConversation[]> {
    const conversations = await this.deps.reads.run(async (scope) => {
      const { reach } = await this.resolve(scope, input.workspaceId, input.identities);
      return scope.conversations.list({ workspaceId: input.workspaceId, conversationIds: reach.conversationIds });
    });
    return [...conversations].sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime());
  }

  async export(input: {
    workspaceId: string;
    identities: readonly DataSubjectIdentity[];
    actor: ConversationErasureActor;
  }): Promise<DataSubjectExportDocument> {
    const { document, identities, conversationCount } = await this.deps.reads.run(async (scope) => {
      const { reach, identities: resolved } = await this.resolve(scope, input.workspaceId, input.identities);
      this.assertWithinCap(reach);
      const sections: Record<string, readonly DataSubjectExportRecord[]> = {};
      for (const exporter of scope.exporters) {
        sections[exporter.section] = await exporter.export({ workspaceId: input.workspaceId, ...reach });
      }
      return {
        document: {
          format: DATA_SUBJECT_EXPORT_FORMAT,
          formatVersion: DATA_SUBJECT_EXPORT_FORMAT_VERSION,
          exportedAt: this.now().toISOString(),
          workspaceId: input.workspaceId,
          identities: input.identities.map(({ kind, key }) => ({ kind, key })),
          sections,
        } satisfies DataSubjectExportDocument,
        identities: resolved,
        conversationCount: reach.conversationIds.length,
      };
    });
    await this.record(input, "data_subject.exported", "success", {
      identities,
      conversationCount,
      recordsBySection: Object.fromEntries(Object.entries(document.sections).map(([section, records]) => [section, records.length])),
    });
    return document;
  }

  /**
   * Erases each web visitor among the identities, with their conversations, and then every other
   * conversation the identities reach, each through the conversation erasure and its own audit
   * event, and records one event for the whole request. One already erased meanwhile is skipped.
   * Any other failure stops the erasure, which answers with what it erased so far and is safe to
   * send again.
   */
  async erase(input: {
    workspaceId: string;
    identities: readonly DataSubjectIdentity[];
    actor: ConversationErasureActor;
  }): Promise<DataSubjectErasureReceipt> {
    const { reach, identities } = await this.deps.reads.run((scope) => this.resolve(scope, input.workspaceId, input.identities));
    this.assertWithinCap(reach);
    const receipt: DataSubjectErasureReceipt = { visitorCount: 0, conversationCount: 0, messageCount: 0, complete: false };
    const tally = async (erase: () => Promise<{ conversationCount: number; messageCount: number }>): Promise<boolean> => {
      try {
        const erased = await erase();
        receipt.conversationCount += erased.conversationCount;
        receipt.messageCount += erased.messageCount;
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    };
    let failure: unknown = null;
    try {
      for (const visitorId of reach.visitorIds) {
        if (await tally(() => this.deps.erasure.eraseVisitor({ workspaceId: input.workspaceId, visitorId, actor: input.actor }))) {
          receipt.visitorCount += 1;
        }
      }
      for (const conversationId of reach.conversationIds) {
        await tally(() => this.deps.erasure.eraseConversation({ workspaceId: input.workspaceId, conversationId, actor: input.actor }));
      }
      receipt.complete = true;
    } catch (error) {
      failure = error;
    }
    const recorded = this.record(input, "data_subject.erased", receipt.complete ? "success" : "failure", {
      identities,
      conversationsReached: reach.conversationIds.length,
      ...receipt,
    });
    if (receipt.complete) {
      await recorded;
      return receipt;
    }
    this.deps.logger?.warn({
      workspaceId: input.workspaceId,
      errorType: failure instanceof Error ? failure.name : typeof failure,
      conversationsReached: reach.conversationIds.length,
      visitorCount: receipt.visitorCount,
      conversationCount: receipt.conversationCount,
    }, "Data subject erasure stopped before it finished");
    // The partial receipt still reaches the caller when the record cannot be written either.
    await recorded.catch(() => undefined);
    throw new AppError(
      500,
      "data_subject_erasure_incomplete",
      "The erasure stopped before it erased everything the identities reach. Send the same request again to erase the rest.",
      { receipt },
    );
  }

  /** Each finder reaches the keys of its own kind; the subject's reach is all of theirs together. */
  private async resolve(scope: DataSubjectReadScope, workspaceId: string, identities: readonly DataSubjectIdentity[]): Promise<ResolvedIdentities> {
    const keysByKind = new Map<string, string[]>();
    for (const identity of identities) {
      this.finderFor(scope, identity);
      keysByKind.set(identity.kind, [...(keysByKind.get(identity.kind) ?? []), identity.key]);
    }
    const reaches: DataSubjectReach[] = [];
    const records: IdentityRecords[] = [];
    for (const finder of scope.finders) {
      const keys = keysByKind.get(finder.kind);
      if (!keys) continue;
      const { recordIds, ...reach } = await finder.reach({ workspaceId, keys: [...new Set(keys)] });
      reaches.push(reach);
      records.push({ kind: finder.kind, recordIds: [...new Set(recordIds)].sort() });
    }
    return { reach: mergeReaches(reaches), identities: records };
  }

  /** Refuses a request too large to answer inside one request, before anything is read out or erased. */
  private assertWithinCap(reach: DataSubjectReach): void {
    const conversationCount = reach.conversationIds.length;
    if (conversationCount <= this.maxConversations) return;
    throw new AppError(
      413,
      "data_subject_request_too_large",
      `These identities reach ${conversationCount} conversations; one request may reach at most ${this.maxConversations}. Split the request by identity.`,
      { conversationCount, maxConversations: this.maxConversations },
    );
  }

  private finderFor(scope: DataSubjectReadScope, identity: DataSubjectIdentity): DataSubjectIdentityFinder {
    const finder = scope.finders.find((candidate) => candidate.kind === identity.kind);
    if (!finder) throw badRequest(`No identities of kind ${identity.kind}`);
    return finder;
  }

  private async record(
    input: { workspaceId: string; actor: ConversationErasureActor },
    eventType: string,
    eventStatus: "success" | "failure",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      accountId: input.actor.accountId,
      workspaceId: input.workspaceId,
      eventType,
      eventStatus,
      metadata: { actorUserId: input.actor.userId, ...metadata },
    });
  }
}
