import { describe, expect, it, vi } from "vitest";

import { defaultDataSubjectIdentityFinders } from "../../src/app/composition/dataSubjectAccess.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";
import {
  DataSubjectAccessService,
  type ConversationErasure,
  type DataSubjectConversation,
  type DataSubjectReadScope,
} from "../../src/modules/privacy/public.js";
import {
  DATA_SUBJECT_IDENTITY_KINDS,
  type DataSubjectDataExporter,
  type DataSubjectExportScope,
  type DataSubjectIdentityFinder,
  type DataSubjectIdentityKind,
  type DataSubjectIdentityMatch,
  type DataSubjectIdentityReach,
} from "../../src/shared/domain/dataSubjectAccess.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { AppError, notFound } from "../../src/shared/domain/errors.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACTOR = { accountId: "acct-1", userId: "user-1" };
const NOW = new Date("2026-10-19T12:00:00.000Z");
const ADDRESS = "jane@example.com";

const noReach: DataSubjectIdentityReach = { conversationIds: [], visitorIds: [], verifiedCustomerIds: [], recordIds: [] };

const finder = (
  kind: DataSubjectIdentityKind,
  options: {
    channel: string;
    matches?: Record<string, DataSubjectIdentityMatch[]>;
    reach?: Record<string, Partial<DataSubjectIdentityReach>>;
  },
) => {
  const reached: string[][] = [];
  const port: DataSubjectIdentityFinder = {
    kind,
    channel: options.channel,
    async find({ query }) {
      return options.matches?.[query] ?? [];
    },
    async reach({ keys }) {
      reached.push([...keys]);
      const parts = keys.map((key) => ({ ...noReach, ...options.reach?.[key] }));
      return {
        conversationIds: parts.flatMap((part) => part.conversationIds),
        visitorIds: parts.flatMap((part) => part.visitorIds),
        verifiedCustomerIds: parts.flatMap((part) => part.verifiedCustomerIds),
        recordIds: parts.flatMap((part) => part.recordIds),
      };
    },
  };
  return { port, reached };
};

const match = (key: string, label: string, conversationCount: number, recordIds: string[]): DataSubjectIdentityMatch => ({
  key,
  label,
  conversationCount,
  recordIds,
  firstSeenAt: new Date("2026-09-01T08:00:00.000Z"),
  lastSeenAt: new Date("2026-10-01T08:00:00.000Z"),
});

const conversation = (id: string, channel: string, lastActivityAt: string): DataSubjectConversation => ({
  id,
  channel,
  title: `About ${id}`,
  startedAt: new Date("2026-09-01T08:00:00.000Z"),
  lastActivityAt: new Date(lastActivityAt),
  messageCount: 2,
});

const createHarness = (options: { maxConversations?: number; auditFails?: boolean } = {}) => {
  const web = finder("web_visitor", {
    channel: "web",
    matches: { "cust-42": [match("visitor-1", "cust-42", 2, ["visitor-1"])] },
    reach: { "visitor-1": { conversationIds: ["conv-web-1", "conv-web-2"], visitorIds: ["visitor-1"], verifiedCustomerIds: ["cust-42"], recordIds: ["visitor-1"] } },
  });
  // Email thread links are keyed by their conversation.
  const email = finder("email_address", {
    channel: "email",
    matches: { [ADDRESS]: [match(ADDRESS, ADDRESS, 1, ["conv-mail-1"])] },
    reach: { [ADDRESS]: { conversationIds: ["conv-mail-1", "conv-web-1"], recordIds: ["conv-mail-1", "conv-web-1"] } },
  });
  const slack = finder("slack_user", { channel: "slack" });
  const exportScopes: DataSubjectExportScope[] = [];
  const exported: string[] = [];
  const exporters: DataSubjectDataExporter[] = [
    {
      section: "conversations",
      async export(scope) {
        exportScopes.push(scope);
        exported.push("conversations");
        return scope.conversationIds.map((id) => ({ id, messages: [{ role: "user", content: "My order 1182 never arrived" }] }));
      },
    },
    { section: "routine_values", async export() { return []; } },
  ];
  const directory = {
    list: vi.fn(async ({ conversationIds }: { workspaceId: string; conversationIds: readonly string[] }) => conversationIds.map((id) =>
      conversation(id, id.startsWith("conv-mail") ? "email" : "web", id === "conv-mail-1" ? "2026-10-10T00:00:00.000Z" : `2026-10-0${id.endsWith("1") ? 2 : 3}T00:00:00.000Z`))),
  };
  let runs = 0;
  const reads = {
    run: async <T>(work: (scope: DataSubjectReadScope) => Promise<T>): Promise<T> => {
      runs += 1;
      return work({ finders: [web.port, email.port, slack.port], exporters, conversations: directory });
    },
  };
  const audit: AuditEventInput[] = [];
  const erasure = {
    eraseConversation: vi.fn<ConversationErasure["eraseConversation"]>(async () => ({ conversationCount: 1, messageCount: 3, rowsByOwner: {} })),
    eraseVisitor: vi.fn<ConversationErasure["eraseVisitor"]>(async () => ({ conversationCount: 2, messageCount: 5, rowsByOwner: {} })),
  };
  const logger = { warn: vi.fn() };
  const service = new DataSubjectAccessService({
    reads,
    erasure,
    audit: {
      record: async (event) => {
        if (options.auditFails) throw new Error("audit store unavailable");
        audit.push(event);
      },
    },
    now: () => NOW,
    logger,
    ...(options.maxConversations === undefined ? {} : { maxConversations: options.maxConversations }),
  });
  return { service, web, email, slack, directory, exportScopes, exported, audit, erasure, logger, runs: () => runs };
};

const confirmed = [
  { kind: "web_visitor" as const, key: "visitor-1" },
  { kind: "email_address" as const, key: ADDRESS },
];
const visitorOnly = [confirmed[0]];

describe("DataSubjectAccessService", () => {
  describe("lookup", () => {
    it("asks every finder and returns each match as a candidate identity, merging none", async () => {
      const h = createHarness();

      const candidates = await h.service.lookup({ workspaceId: WORKSPACE, query: "  cust-42 ", actor: ACTOR });

      expect(candidates).toEqual([{
        identity: { kind: "web_visitor", key: "visitor-1" },
        channel: "web",
        label: "cust-42",
        conversationCount: 2,
        firstSeenAt: new Date("2026-09-01T08:00:00.000Z"),
        lastSeenAt: new Date("2026-10-01T08:00:00.000Z"),
      }]);
    });

    it("records who looked up and the identity records they found, never the query or a key", async () => {
      const h = createHarness();

      await h.service.lookup({ workspaceId: WORKSPACE, query: ADDRESS, actor: ACTOR });

      expect(h.audit).toEqual([{
        accountId: ACTOR.accountId,
        workspaceId: WORKSPACE,
        eventType: "data_subject.looked_up",
        eventStatus: "success",
        metadata: {
          actorUserId: ACTOR.userId,
          identities: [{ kind: "email_address", recordIds: ["conv-mail-1"] }],
          identityCount: 1,
          conversationCount: 1,
        },
      }]);
    });

    it("records a lookup that found nobody", async () => {
      const h = createHarness();

      expect(await h.service.lookup({ workspaceId: WORKSPACE, query: "nobody@example.com", actor: ACTOR })).toEqual([]);

      expect(h.audit[0].metadata).toMatchObject({ identities: [], identityCount: 0, conversationCount: 0 });
    });
  });

  describe("listConversations", () => {
    it("lists what the confirmed identities reach, each conversation once, latest activity first", async () => {
      const h = createHarness();

      const conversations = await h.service.listConversations({ workspaceId: WORKSPACE, identities: confirmed });

      expect(conversations.map((entry) => entry.id)).toEqual(["conv-mail-1", "conv-web-2", "conv-web-1"]);
      expect(h.web.reached).toEqual([["visitor-1"]]);
      expect(h.email.reached).toEqual([[ADDRESS]]);
      expect(h.slack.reached).toEqual([]);
    });
  });

  describe("export", () => {
    it("writes one versioned document with every registered section, in one read", async () => {
      const h = createHarness();

      const document = await h.service.export({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(document).toEqual({
        format: "radioso.data_subject_export",
        formatVersion: 1,
        exportedAt: NOW.toISOString(),
        workspaceId: WORKSPACE,
        identities: confirmed,
        sections: {
          conversations: [
            { id: "conv-mail-1", messages: [{ role: "user", content: "My order 1182 never arrived" }] },
            { id: "conv-web-1", messages: [{ role: "user", content: "My order 1182 never arrived" }] },
            { id: "conv-web-2", messages: [{ role: "user", content: "My order 1182 never arrived" }] },
          ],
          routine_values: [],
        },
      });
      expect(h.exportScopes).toEqual([{
        workspaceId: WORKSPACE,
        conversationIds: ["conv-mail-1", "conv-web-1", "conv-web-2"],
        visitorIds: ["visitor-1"],
        verifiedCustomerIds: ["cust-42"],
      }]);
      expect(h.runs()).toBe(1);
    });

    it("audits counts per section and each identity kind's records, never a key or content", async () => {
      const h = createHarness();

      await h.service.export({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(h.audit).toEqual([expect.objectContaining({
        eventType: "data_subject.exported",
        eventStatus: "success",
        metadata: {
          actorUserId: ACTOR.userId,
          identities: [
            { kind: "web_visitor", recordIds: ["visitor-1"] },
            { kind: "email_address", recordIds: ["conv-mail-1", "conv-web-1"] },
          ],
          conversationCount: 3,
          recordsBySection: { conversations: 3, routine_values: 0 },
        },
      })]);
      const recorded = JSON.stringify(h.audit);
      expect(recorded).not.toContain(ADDRESS);
      expect(recorded).not.toContain("1182");
    });

    it("exports a request that reaches exactly the most conversations one request may", async () => {
      const h = createHarness({ maxConversations: 3 });

      const document = await h.service.export({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(document.sections.conversations).toHaveLength(3);
    });

    it("refuses a request that reaches one more, before exporting or recording anything", async () => {
      const h = createHarness({ maxConversations: 2 });

      const refusal = await h.service.export({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(AppError);
      expect(refusal).toMatchObject({
        statusCode: 413,
        code: "data_subject_request_too_large",
        details: { conversationCount: 3, maxConversations: 2 },
      });
      expect((refusal as AppError).message).toContain("conversationIds");
      expect(h.exported).toEqual([]);
      expect(h.audit).toEqual([]);
    });

    it("exports one identity past the cap in pages of its conversations, each with the identity's own records", async () => {
      const h = createHarness({ maxConversations: 1 });
      await expect(h.service.export({ workspaceId: WORKSPACE, identities: visitorOnly, actor: ACTOR }))
        .rejects.toMatchObject({ statusCode: 413, code: "data_subject_request_too_large" });

      const pages = [];
      for (const conversationIds of [["conv-web-2"], ["conv-web-1"]]) {
        pages.push(await h.service.export({ workspaceId: WORKSPACE, identities: visitorOnly, conversationIds, actor: ACTOR }));
      }

      expect(pages.flatMap((page) => page.sections.conversations.map((record) => record.id))).toEqual(["conv-web-2", "conv-web-1"]);
      expect(h.exportScopes).toEqual([
        { workspaceId: WORKSPACE, conversationIds: ["conv-web-2"], visitorIds: ["visitor-1"], verifiedCustomerIds: ["cust-42"] },
        { workspaceId: WORKSPACE, conversationIds: ["conv-web-1"], visitorIds: ["visitor-1"], verifiedCustomerIds: ["cust-42"] },
      ]);
      expect(h.audit.map((event) => event.metadata)).toEqual([
        expect.objectContaining({ conversationCount: 1 }),
        expect.objectContaining({ conversationCount: 1 }),
      ]);
    });

    it("refuses a page listing a conversation the identities do not reach, before reading out or erasing anything", async () => {
      const h = createHarness();
      // conv-mail-1 is the email identity's, which this request does not name.
      const conversationIds = ["conv-web-1", "conv-mail-1"];

      for (const run of [
        () => h.service.export({ workspaceId: WORKSPACE, identities: visitorOnly, conversationIds, actor: ACTOR }),
        () => h.service.erase({ workspaceId: WORKSPACE, identities: visitorOnly, conversationIds, actor: ACTOR }),
      ]) {
        await expect(run()).rejects.toMatchObject({
          statusCode: 400,
          code: "data_subject_conversations_not_reached",
          details: { conversationIds: ["conv-mail-1"] },
        });
      }
      expect(h.exported).toEqual([]);
      expect(h.erasure.eraseVisitor).not.toHaveBeenCalled();
      expect(h.erasure.eraseConversation).not.toHaveBeenCalled();
      expect(h.audit).toEqual([]);
    });
  });

  describe("erase", () => {
    it("erases each visitor with their conversations, then every other conversation the identities reach", async () => {
      const h = createHarness();
      h.erasure.eraseConversation.mockImplementation(async ({ conversationId }) => {
        // The visitor's erasure already took its conversations.
        if (conversationId.startsWith("conv-web")) throw notFound("Conversation not found");
        return { conversationCount: 1, messageCount: 3, rowsByOwner: {} };
      });

      const receipt = await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(h.erasure.eraseVisitor).toHaveBeenCalledWith({ workspaceId: WORKSPACE, visitorId: "visitor-1", actor: ACTOR });
      expect(h.erasure.eraseConversation.mock.calls.map(([input]) => input.conversationId)).toEqual(["conv-mail-1", "conv-web-1", "conv-web-2"]);
      expect(h.erasure.eraseVisitor.mock.invocationCallOrder[0]).toBeLessThan(h.erasure.eraseConversation.mock.invocationCallOrder[0]);
      expect(receipt).toEqual({ visitorCount: 1, conversationCount: 3, messageCount: 8, complete: true });
    });

    it("goes on past a visitor or conversation erased meanwhile", async () => {
      const h = createHarness();
      h.erasure.eraseVisitor.mockRejectedValueOnce(notFound("Visitor not found"));
      h.erasure.eraseConversation.mockRejectedValue(notFound("Conversation not found"));

      expect(await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR }))
        .toEqual({ visitorCount: 0, conversationCount: 0, messageCount: 0, complete: true });
    });

    it("stops at an erasure that fails for any other reason and answers with what it erased so far", async () => {
      const h = createHarness();
      h.erasure.eraseConversation.mockRejectedValueOnce(new Error("deadlock"));

      const failure = await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        statusCode: 500,
        code: "data_subject_erasure_incomplete",
        details: { receipt: { visitorCount: 1, conversationCount: 2, messageCount: 5, complete: false } },
      });
      expect(h.erasure.eraseConversation).toHaveBeenCalledTimes(1);
      expect(h.audit).toEqual([expect.objectContaining({
        eventType: "data_subject.erased",
        eventStatus: "failure",
        metadata: expect.objectContaining({ visitorCount: 1, conversationCount: 2, messageCount: 5, complete: false }),
      })]);
    });

    it("records one event for the request, with each identity kind's records and the totals", async () => {
      const h = createHarness();

      await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(h.audit).toEqual([{
        accountId: ACTOR.accountId,
        workspaceId: WORKSPACE,
        eventType: "data_subject.erased",
        eventStatus: "success",
        metadata: {
          actorUserId: ACTOR.userId,
          identities: [
            { kind: "web_visitor", recordIds: ["visitor-1"] },
            { kind: "email_address", recordIds: ["conv-mail-1", "conv-web-1"] },
          ],
          conversationsReached: 3,
          visitorCount: 1,
          conversationCount: 5,
          messageCount: 14,
          complete: true,
        },
      }]);
      expect(JSON.stringify(h.audit)).not.toContain(ADDRESS);
    });

    it("erases a request at the cap, and refuses one past it before erasing anything", async () => {
      const atCap = createHarness({ maxConversations: 3 });
      await atCap.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });
      expect(atCap.erasure.eraseVisitor).toHaveBeenCalledTimes(1);

      const pastCap = createHarness({ maxConversations: 2 });
      await expect(pastCap.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR }))
        .rejects.toMatchObject({ statusCode: 413, code: "data_subject_request_too_large" });
      expect(pastCap.erasure.eraseVisitor).not.toHaveBeenCalled();
      expect(pastCap.erasure.eraseConversation).not.toHaveBeenCalled();
      expect(pastCap.audit).toEqual([]);
    });

    it("erases only a page's listed conversations and no visitor, whose erasure would take all of theirs", async () => {
      const h = createHarness({ maxConversations: 1 });

      const receipt = await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, conversationIds: ["conv-web-2"], actor: ACTOR });

      expect(h.erasure.eraseVisitor).not.toHaveBeenCalled();
      expect(h.erasure.eraseConversation.mock.calls.map(([input]) => input.conversationId)).toEqual(["conv-web-2"]);
      expect(receipt).toEqual({ visitorCount: 0, conversationCount: 1, messageCount: 3, complete: true });
      expect(h.audit).toEqual([expect.objectContaining({
        eventType: "data_subject.erased",
        metadata: expect.objectContaining({ conversationsReached: 1, complete: true }),
      })]);
    });

    it("tells a caller whose page stopped partway to list the conversations again", async () => {
      const h = createHarness();
      h.erasure.eraseConversation.mockRejectedValueOnce(new Error("deadlock"));

      await expect(h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, conversationIds: ["conv-web-1"], actor: ACTOR }))
        .rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining("List the identities' conversations again") });
    });

    it("answers a finished erasure with its receipt when its own audit event cannot be written, and logs ids and counts", async () => {
      const h = createHarness({ auditFails: true });

      const receipt = await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(receipt).toEqual({ visitorCount: 1, conversationCount: 5, messageCount: 14, complete: true });
      expect(h.logger.warn).toHaveBeenCalledWith({
        workspaceId: WORKSPACE,
        errorType: "Error",
        conversationsReached: 3,
        visitorCount: 1,
        conversationCount: 5,
        messageCount: 14,
      }, expect.any(String));
      expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain(ADDRESS);
    });
  });

  it("composes one finder for every identity kind, so each kind a request names has one", () => {
    // Finders only hold the transaction they are bound to, so binding one to nothing reads its kind.
    const kinds = defaultDataSubjectIdentityFinders.map((bind) => bind({} as Db).kind);
    expect([...kinds].sort()).toEqual([...DATA_SUBJECT_IDENTITY_KINDS].sort());
  });
});
