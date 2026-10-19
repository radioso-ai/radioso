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
  type DataSubjectReach,
} from "../../src/shared/domain/dataSubjectAccess.js";
import type { Db } from "../../src/shared/infra/kysely/types.js";
import { notFound } from "../../src/shared/domain/errors.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACTOR = { accountId: "acct-1", userId: "user-1" };
const NOW = new Date("2026-10-19T12:00:00.000Z");
const ADDRESS = "jane@example.com";

const noReach: DataSubjectReach = { conversationIds: [], visitorIds: [], verifiedCustomerIds: [] };

const finder = (
  kind: DataSubjectIdentityKind,
  options: {
    channel: string;
    personalKey: boolean;
    matches?: Record<string, DataSubjectIdentityMatch[]>;
    reach?: Record<string, Partial<DataSubjectReach>>;
  },
) => {
  const reached: string[][] = [];
  const port: DataSubjectIdentityFinder = {
    kind,
    channel: options.channel,
    personalKey: options.personalKey,
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
      };
    },
  };
  return { port, reached };
};

const match = (key: string, label: string, conversationCount: number): DataSubjectIdentityMatch => ({
  key,
  label,
  conversationCount,
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

const createHarness = () => {
  const web = finder("web_visitor", {
    channel: "web",
    personalKey: false,
    matches: { "cust-42": [match("visitor-1", "cust-42", 2)] },
    reach: { "visitor-1": { conversationIds: ["conv-web-1", "conv-web-2"], visitorIds: ["visitor-1"], verifiedCustomerIds: ["cust-42"] } },
  });
  const email = finder("email_address", {
    channel: "email",
    personalKey: true,
    matches: { [ADDRESS]: [match(ADDRESS, ADDRESS, 1)] },
    reach: { [ADDRESS]: { conversationIds: ["conv-mail-1", "conv-web-1"] } },
  });
  const slack = finder("slack_user", { channel: "slack", personalKey: true });
  const exportScopes: DataSubjectExportScope[] = [];
  const exporters: DataSubjectDataExporter[] = [
    {
      section: "conversations",
      async export(scope) {
        exportScopes.push(scope);
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
  const service = new DataSubjectAccessService({
    reads,
    erasure,
    audit: { record: async (event) => { audit.push(event); } },
    now: () => NOW,
  });
  return { service, web, email, slack, directory, exportScopes, audit, erasure, runs: () => runs };
};

const confirmed = [
  { kind: "web_visitor" as const, key: "visitor-1" },
  { kind: "email_address" as const, key: ADDRESS },
];

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

    it("records who looked up and which identities they found, never the query or a personal key", async () => {
      const h = createHarness();

      await h.service.lookup({ workspaceId: WORKSPACE, query: ADDRESS, actor: ACTOR });

      expect(h.audit).toHaveLength(1);
      const [event] = h.audit;
      expect(event).toMatchObject({
        accountId: ACTOR.accountId,
        workspaceId: WORKSPACE,
        eventType: "data_subject.looked_up",
        eventStatus: "success",
        metadata: { actorUserId: ACTOR.userId, identityCount: 1, conversationCount: 1 },
      });
      const identities = event.metadata?.identities as { kind: string; ref: string }[];
      expect(identities).toHaveLength(1);
      expect(identities[0].kind).toBe("email_address");
      expect(identities[0].ref).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(event)).not.toContain(ADDRESS);
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

    it("audits counts per section and the identities by reference, never content", async () => {
      const h = createHarness();

      await h.service.export({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      const [event] = h.audit;
      expect(event).toMatchObject({
        eventType: "data_subject.exported",
        metadata: {
          actorUserId: ACTOR.userId,
          conversationCount: 3,
          recordsBySection: { conversations: 3, routine_values: 0 },
        },
      });
      const identities = event.metadata?.identities as { kind: string; ref: string }[];
      expect(identities[0]).toEqual({ kind: "web_visitor", ref: "visitor-1" });
      expect(identities[1].ref).toMatch(/^sha256:/);
      const recorded = JSON.stringify(event);
      expect(recorded).not.toContain(ADDRESS);
      expect(recorded).not.toContain("1182");
    });

    it("references a personal identity the same way in its lookup and its export", async () => {
      const h = createHarness();

      await h.service.lookup({ workspaceId: WORKSPACE, query: ADDRESS, actor: ACTOR });
      await h.service.export({ workspaceId: WORKSPACE, identities: [{ kind: "email_address", key: ADDRESS }], actor: ACTOR });

      const [lookedUp, exported] = h.audit.map((event) => event.metadata?.identities);
      expect(exported).toEqual(lookedUp);
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
      expect(receipt).toEqual({ visitorCount: 1, conversationCount: 3, messageCount: 8 });
    });

    it("goes on past a visitor or conversation erased meanwhile", async () => {
      const h = createHarness();
      h.erasure.eraseVisitor.mockRejectedValueOnce(notFound("Visitor not found"));
      h.erasure.eraseConversation.mockRejectedValue(notFound("Conversation not found"));

      expect(await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR }))
        .toEqual({ visitorCount: 0, conversationCount: 0, messageCount: 0 });
    });

    it("stops at an erasure that fails for any other reason", async () => {
      const h = createHarness();
      h.erasure.eraseConversation.mockRejectedValueOnce(new Error("deadlock"));

      await expect(h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR })).rejects.toThrow("deadlock");
      expect(h.erasure.eraseConversation).toHaveBeenCalledTimes(1);
    });

    it("leaves the audit to each erasure it runs", async () => {
      const h = createHarness();

      await h.service.erase({ workspaceId: WORKSPACE, identities: confirmed, actor: ACTOR });

      expect(h.audit).toEqual([]);
    });
  });

  it("composes one finder for every identity kind, so each kind a request names has one", () => {
    // Finders only hold the transaction they are bound to, so binding one to nothing reads its kind.
    const kinds = defaultDataSubjectIdentityFinders.map((bind) => bind({} as Db).kind);
    expect([...kinds].sort()).toEqual([...DATA_SUBJECT_IDENTITY_KINDS].sort());
  });
});
