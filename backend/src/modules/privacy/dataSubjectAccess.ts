import { createHash } from "node:crypto";

import type { AuditEventInput } from "../audit/contracts/index.js";
import type {
  DataSubjectDataExporter,
  DataSubjectExportRecord,
  DataSubjectIdentity,
  DataSubjectIdentityFinder,
  DataSubjectReach,
} from "../../shared/domain/dataSubjectAccess.js";
import { AppError, badRequest } from "../../shared/domain/errors.js";
import type { ConversationErasure, ConversationErasureActor } from "./conversationErasure.js";

/** The export format's name and version. A change to its shape is a new version. */
export const DATA_SUBJECT_EXPORT_FORMAT = "radioso.data_subject_export";
export const DATA_SUBJECT_EXPORT_FORMAT_VERSION = 1;

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

/** What a subject's erasure removed. */
export interface DataSubjectErasureReceipt {
  visitorCount: number;
  conversationCount: number;
  messageCount: number;
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
}

/** How an audit event names an identity: its key when Radioso minted it, a digest when it is the person's own. */
interface IdentityReference {
  kind: string;
  ref: string;
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

  constructor(private readonly deps: DataSubjectAccessDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async lookup(input: { workspaceId: string; query: string; actor: ConversationErasureActor }): Promise<DataSubjectIdentityCandidate[]> {
    const query = input.query.trim();
    const { candidates, references } = await this.deps.reads.run(async ({ finders }) => {
      const found: DataSubjectIdentityCandidate[] = [];
      const refs: IdentityReference[] = [];
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
          refs.push(this.reference(input.workspaceId, finder, identity));
        }
      }
      return { candidates: found, references: refs };
    });
    await this.record(input, "data_subject.looked_up", {
      identities: references,
      identityCount: candidates.length,
      conversationCount: candidates.reduce((total, candidate) => total + candidate.conversationCount, 0),
    });
    return candidates;
  }

  async listConversations(input: { workspaceId: string; identities: readonly DataSubjectIdentity[] }): Promise<DataSubjectConversation[]> {
    const conversations = await this.deps.reads.run(async (scope) => {
      const reach = await this.reach(scope, input.workspaceId, input.identities);
      return scope.conversations.list({ workspaceId: input.workspaceId, conversationIds: reach.conversationIds });
    });
    return [...conversations].sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime());
  }

  async export(input: {
    workspaceId: string;
    identities: readonly DataSubjectIdentity[];
    actor: ConversationErasureActor;
  }): Promise<DataSubjectExportDocument> {
    const { document, references, conversationCount } = await this.deps.reads.run(async (scope) => {
      const reach = await this.reach(scope, input.workspaceId, input.identities);
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
        references: input.identities.map((identity) => this.reference(input.workspaceId, this.finderFor(scope, identity), identity)),
        conversationCount: reach.conversationIds.length,
      };
    });
    await this.record(input, "data_subject.exported", {
      identities: references,
      conversationCount,
      recordsBySection: Object.fromEntries(Object.entries(document.sections).map(([section, records]) => [section, records.length])),
    });
    return document;
  }

  /**
   * Erases each web visitor among the identities, with their conversations, and then every other
   * conversation the identities reach, each through the conversation erasure and its own audit
   * event. One already erased meanwhile is skipped; any other failure stops the erasure, which is
   * safe to run again.
   */
  async erase(input: {
    workspaceId: string;
    identities: readonly DataSubjectIdentity[];
    actor: ConversationErasureActor;
  }): Promise<DataSubjectErasureReceipt> {
    const reach = await this.deps.reads.run((scope) => this.reach(scope, input.workspaceId, input.identities));
    const receipt: DataSubjectErasureReceipt = { visitorCount: 0, conversationCount: 0, messageCount: 0 };
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
    for (const visitorId of reach.visitorIds) {
      if (await tally(() => this.deps.erasure.eraseVisitor({ workspaceId: input.workspaceId, visitorId, actor: input.actor }))) {
        receipt.visitorCount += 1;
      }
    }
    for (const conversationId of reach.conversationIds) {
      await tally(() => this.deps.erasure.eraseConversation({ workspaceId: input.workspaceId, conversationId, actor: input.actor }));
    }
    return receipt;
  }

  /** Each finder reaches the keys of its own kind; the subject's reach is all of theirs together. */
  private async reach(scope: DataSubjectReadScope, workspaceId: string, identities: readonly DataSubjectIdentity[]): Promise<DataSubjectReach> {
    const keysByKind = new Map<string, string[]>();
    for (const identity of identities) {
      this.finderFor(scope, identity);
      keysByKind.set(identity.kind, [...(keysByKind.get(identity.kind) ?? []), identity.key]);
    }
    const reaches: DataSubjectReach[] = [];
    for (const finder of scope.finders) {
      const keys = keysByKind.get(finder.kind);
      if (keys) reaches.push(await finder.reach({ workspaceId, keys: [...new Set(keys)] }));
    }
    return mergeReaches(reaches);
  }

  private finderFor(scope: DataSubjectReadScope, identity: DataSubjectIdentity): DataSubjectIdentityFinder {
    const finder = scope.finders.find((candidate) => candidate.kind === identity.kind);
    if (!finder) throw badRequest(`No identities of kind ${identity.kind}`);
    return finder;
  }

  private reference(workspaceId: string, finder: DataSubjectIdentityFinder, identity: DataSubjectIdentity): IdentityReference {
    if (!finder.personalKey) return { kind: identity.kind, ref: identity.key };
    const digest = createHash("sha256").update(`${workspaceId}\n${identity.kind}\n${identity.key}`).digest("hex");
    return { kind: identity.kind, ref: `sha256:${digest}` };
  }

  private async record(
    input: { workspaceId: string; actor: ConversationErasureActor },
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      accountId: input.actor.accountId,
      workspaceId: input.workspaceId,
      eventType,
      eventStatus: "success",
      metadata: { actorUserId: input.actor.userId, ...metadata },
    });
  }
}
