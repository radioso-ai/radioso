import { describe, expect, it } from "vitest";

import type { AuditEventInput } from "../../../src/modules/audit/contracts/index.js";
import {
  ConsentWithdrawalService,
  type ConsentRecord,
  type ConsentWithdrawalWriteScope,
} from "../../../src/modules/privacy/public.js";
import type { MessageCopyWithholder, WithheldMessages } from "../../../src/shared/domain/messageWithholding.js";
import type { RoutineConsentWithdrawn } from "../../../src/shared/domain/routineConsentRecord.js";
import { containsValueText } from "../../../src/shared/domain/sensitiveTranscript.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const RECORD = "33333333-3333-4333-8333-333333333333";
const ACTOR = { accountId: "acct-1", userId: "user-1" };
const WITHDRAWN_AT = new Date("2026-11-12T10:00:00.000Z");

const granted: ConsentRecord = {
  id: RECORD,
  routineId: "routine-intake",
  consentKey: "health",
  slotKeys: ["injury"],
  decision: "granted",
  method: "button",
  defaulted: false,
  locale: "en",
  channel: "website_embed",
  wordingVersionId: "wording-1",
  wording: { body: "We ask about injuries only to adapt your class.", agreeLabel: "I agree", declineLabel: "No thanks" },
  decidedAt: new Date("2026-11-10T09:00:00.000Z"),
  withdrawnAt: null,
};

interface FakeState {
  records: ConsentRecord[];
  routineValues: Record<string, unknown>;
  /** Message id to the sensitive slot keys its metadata names. */
  markedMessages: Record<string, string[]>;
  /** Message id to its text. */
  texts: Record<string, string>;
  withheld: string[];
  audit: AuditEventInput[];
}

/**
 * One in-memory "database" with transaction semantics: the work runs against a copy, which replaces
 * the committed state only when the work resolves.
 */
const createFake = (input: {
  records: ConsentRecord[];
  markedMessages?: Record<string, string[]>;
  texts?: Record<string, string>;
  routineValues?: Record<string, unknown>;
  copyRows?: number;
}) => {
  let committed: FakeState = {
    records: input.records.map((record) => ({ ...record })),
    routineValues: input.routineValues ?? { name: "Ada", injury: "sore knee" },
    markedMessages: input.markedMessages ?? {},
    texts: input.texts ?? {},
    withheld: [],
    audit: [],
  };
  const order: string[] = [];
  const copyScopes: WithheldMessages[] = [];
  const copies: MessageCopyWithholder = {
    owner: "email-channel",
    async withhold(messages) {
      order.push("copies");
      copyScopes.push(messages);
      return input.copyRows ?? 0;
    },
  };
  const unitOfWork = {
    async run<T>(work: (scope: ConsentWithdrawalWriteScope) => Promise<T>): Promise<T> {
      const draft: FakeState = structuredClone(committed);
      const scope: ConsentWithdrawalWriteScope = {
        records: {
          async lock({ workspaceId, conversationId, recordId }) {
            order.push("lock");
            return workspaceId === WORKSPACE && conversationId === CONVERSATION
              ? draft.records.find((record) => record.id === recordId) ?? null
              : null;
          },
          async markWithdrawn({ recordId }) {
            order.push("mark");
            const record = draft.records.find((candidate) => candidate.id === recordId)!;
            record.withdrawnAt = WITHDRAWN_AT;
            return WITHDRAWN_AT;
          },
        },
        routineValues: {
          async erase({ slotKeys }) {
            order.push("erase");
            const erased = Object.fromEntries(slotKeys.filter((key) => key in draft.routineValues).map((key) => [key, draft.routineValues[key]]));
            for (const key of slotKeys) delete draft.routineValues[key];
            return erased;
          },
        },
        messages: {
          async withhold({ slotKeys, valueTexts }) {
            order.push("withhold");
            const marked = Object.entries(draft.markedMessages)
              .filter(([, keys]) => keys.some((key) => slotKeys.includes(key)))
              .map(([id]) => id);
            const stated = Object.entries(draft.texts)
              .filter(([, text]) => containsValueText(text, valueTexts))
              .map(([id]) => id);
            const ids = [...new Set([...marked, ...stated])];
            draft.withheld.push(...ids);
            return ids;
          },
        },
        messageCopies: [copies],
        audit: {
          async record(event) {
            order.push("audit");
            draft.audit.push(event);
          },
        },
      };
      const result = await work(scope);
      committed = draft;
      return result;
    },
  };
  const loggedAudit: AuditEventInput[] = [];
  const withdrawals: RoutineConsentWithdrawn[] = [];
  const invalidations: Array<{ workspaceId: string; kinds: readonly string[] }> = [];
  const service = new ConsentWithdrawalService({
    unitOfWork,
    records: { listForConversation: async () => committed.records },
    auditLog: { logRecorded: (event) => void loggedAudit.push(event) },
    telemetry: { withdrawn: (event) => void withdrawals.push(event) },
    invalidation: {
      enqueue: (workspaceId, kinds) => {
        invalidations.push({ workspaceId, kinds });
        return { accepted: true, coalesced: false };
      },
    },
  });
  return { service, state: () => committed, order, copyScopes, loggedAudit, withdrawals, invalidations };
};

const withdraw = (fake: ReturnType<typeof createFake>, recordId = RECORD) =>
  fake.service.withdraw({ workspaceId: WORKSPACE, conversationId: CONVERSATION, recordId, actor: ACTOR });

describe("ConsentWithdrawalService", () => {
  it("withdraws a granted consent: erases what it covered, withholds the messages that carried it, and records who asked", async () => {
    const fake = createFake({ records: [granted], markedMessages: { "message-1": ["injury"], "message-2": ["injury"], "message-3": ["other"] }, copyRows: 2 });

    const outcome = await withdraw(fake);

    expect(outcome).toEqual({ kind: "withdrawn", consent: { ...granted, withdrawnAt: WITHDRAWN_AT } });
    expect(fake.state().routineValues).toEqual({ name: "Ada" });
    expect(fake.state().withheld).toEqual(["message-1", "message-2"]);
    expect(fake.copyScopes).toEqual([{ workspaceId: WORKSPACE, conversationId: CONVERSATION, messageIds: ["message-1", "message-2"], valueTexts: ["sore knee"] }]);
    expect(fake.order).toEqual(["lock", "mark", "erase", "withhold", "copies", "audit"]);
    expect(fake.state().audit).toEqual([{
      accountId: ACTOR.accountId,
      workspaceId: WORKSPACE,
      eventType: "routine_consent.withdrawn",
      eventStatus: "success",
      metadata: {
        actorUserId: ACTOR.userId,
        conversationId: CONVERSATION,
        routineId: "routine-intake",
        consentKey: "health",
        recordId: RECORD,
        withheldMessageCount: 2,
        rowsByOwner: { "email-channel": 2 },
      },
    }]);
    // Logged and counted only once the transaction committed, with ids and counts alone.
    expect(fake.loggedAudit).toEqual(fake.state().audit);
    expect(fake.withdrawals).toEqual([{
      workspaceId: WORKSPACE,
      conversationId: CONVERSATION,
      channel: "website_embed",
      routineId: "routine-intake",
      consentKey: "health",
      wordingVersionId: "wording-1",
      recordId: RECORD,
      withheldMessageCount: 2,
    }]);
    // Operator views listing the conversation re-read it once the withdrawal committed.
    expect(fake.invalidations).toEqual([{ workspaceId: WORKSPACE, kinds: ["conversation.turn_committed"] }]);
  });

  it("withholds every message that states an erased value, marked or not", async () => {
    const fake = createFake({
      records: [granted],
      texts: {
        // Said before any routine asked, and repeated by a reply after the routine ended.
        "before-routine": "Do you treat a SORE   knee?",
        "after-routine": "You told me about your sore knee.",
        "unrelated": "When is the next class?",
      },
    });

    await withdraw(fake);

    expect(fake.state().withheld).toEqual(["before-routine", "after-routine"]);
    expect(fake.copyScopes).toEqual([{ workspaceId: WORKSPACE, conversationId: CONVERSATION, messageIds: ["before-routine", "after-routine"], valueTexts: ["sore knee"] }]);
  });

  it("searches no text for a value too short, a number or a yes or no, and finds those messages by their marker", async () => {
    const fake = createFake({
      records: [{ ...granted, slotKeys: ["injury", "pregnant", "weeks", "side"] }],
      routineValues: { injury: "flu", pregnant: true, weeks: 12, side: ["left knee", "ok"] },
      markedMessages: { "message-1": ["pregnant"] },
      texts: { "short": "I have the flu", "number": "12 weeks along", "list": "My LEFT knee hurts" },
    });

    await withdraw(fake);

    expect(fake.state().withheld).toEqual(["message-1", "list"]);
    expect(fake.copyScopes[0]?.valueTexts).toEqual(["left knee"]);
  });

  it("asks no module to withhold copies when no message carried a covered value and none was held", async () => {
    const fake = createFake({ records: [granted], routineValues: { name: "Ada" } });

    await withdraw(fake);

    expect(fake.copyScopes).toEqual([]);
    expect(fake.state().audit[0]?.metadata).toMatchObject({ withheldMessageCount: 0, rowsByOwner: {} });
  });

  it("still asks every module to withhold its copies stating a held value when no message did", async () => {
    const fake = createFake({ records: [granted], copyRows: 1 });

    await withdraw(fake);

    expect(fake.copyScopes).toEqual([{ workspaceId: WORKSPACE, conversationId: CONVERSATION, messageIds: [], valueTexts: ["sore knee"] }]);
    expect(fake.state().audit[0]?.metadata).toMatchObject({ withheldMessageCount: 0, rowsByOwner: { "email-channel": 1 } });
  });

  it("refuses a declined consent and changes nothing", async () => {
    const declined: ConsentRecord = { ...granted, decision: "declined" };
    const fake = createFake({ records: [declined], markedMessages: { "message-1": ["injury"] } });

    const outcome = await withdraw(fake);

    expect(outcome).toEqual({ kind: "not_withdrawable", reason: "declined", consent: declined });
    expect(fake.state().routineValues).toEqual({ name: "Ada", injury: "sore knee" });
    expect(fake.state().withheld).toEqual([]);
    expect(fake.state().audit).toEqual([]);
    expect(fake.loggedAudit).toEqual([]);
    expect(fake.withdrawals).toEqual([]);
    expect(fake.invalidations).toEqual([]);
  });

  it("refuses a consent already withdrawn and changes nothing", async () => {
    const withdrawn: ConsentRecord = { ...granted, withdrawnAt: new Date("2026-11-11T08:00:00.000Z") };
    const fake = createFake({ records: [withdrawn], markedMessages: { "message-1": ["injury"] } });

    const outcome = await withdraw(fake);

    expect(outcome).toEqual({ kind: "not_withdrawable", reason: "already_withdrawn", consent: withdrawn });
    expect(fake.order).toEqual(["lock"]);
    expect(fake.state().audit).toEqual([]);
    expect(fake.withdrawals).toEqual([]);
  });

  it("answers not found for a record the conversation does not have", async () => {
    const fake = createFake({ records: [granted] });

    expect(await withdraw(fake, "44444444-4444-4444-8444-444444444444")).toEqual({ kind: "not_found" });
    expect(await fake.service.withdraw({ workspaceId: WORKSPACE, conversationId: "55555555-5555-4555-8555-555555555555", recordId: RECORD, actor: ACTOR }))
      .toEqual({ kind: "not_found" });
    expect(fake.state().audit).toEqual([]);
  });

  it("lists a conversation's consent records", async () => {
    const fake = createFake({ records: [granted] });

    expect(await fake.service.list({ workspaceId: WORKSPACE, conversationId: CONVERSATION })).toEqual([granted]);
  });
});
