import { describe, expect, it } from "vitest";

import { normalizePrivacyNotices } from "../../../src/modules/agents/public.js";
import { SendCommitment, type EmailFirstReplyNoticeFacts, type EmailSendCommitmentUnitOfWork } from "../../../src/modules/emailChannel/public.js";
import { rfcMessageId } from "../../../src/modules/mail/public.js";
import type { EmailSendIntentRecord } from "../../../src/modules/emailChannel/persistence/emailSendIntentRepository.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

type Harness = ReturnType<typeof createSendPathHarness>;

/**
 * The commitment over the harness's stores, recording every read and write its one unit makes, in
 * order, and how many units it opened.
 */
const recordingCommitment = (h: Harness, options: { pendingNotices?: EmailFirstReplyNoticeFacts } = {}) => {
  const calls: string[] = [];
  const units = { opened: 0 };
  const recorded: { conversationId: string; version: string }[] = [];
  const unitOfWork: EmailSendCommitmentUnitOfWork = {
    run: async (work) => {
      units.opened += 1;
      return work({
        firstReplyNotice: {
          pending: async () => {
            if (!options.pendingNotices) return null;
            calls.push("conversation");
            return options.pendingNotices;
          },
          record: async ({ conversationId, version }) => {
            calls.push("notice_recorded");
            recorded.push({ conversationId, version });
          },
        },
        conversations: {
          lockOwnership: async ({ conversationId }) => {
            calls.push("conversation+ownership");
            return h.owners.get(conversationId) ?? null;
          },
        },
        mailboxes: { lockForSend: async (id) => (calls.push("mailbox"), h.mailboxes.findById(id)) },
        domains: { lockForSend: async (id) => (calls.push("domain"), h.domains.findById(id)) },
        threads: {
          lockLinkForSend: async (id) => (calls.push("thread"), h.threads.findLink(id)),
          findLatestInboundThreading: (id) => h.threads.findLatestInboundThreading(id),
        },
        messages: { findByIdAndWorkspaceId: async (_workspaceId, id) => h.messages.get(id) ?? null },
        intents: {
          freezeRequest: async (...args) => {
            calls.push("freeze");
            return h.intents.freezeRequest(...args);
          },
          listByMessageId: (messageId) => h.intents.listByMessageId(messageId),
        },
      });
    },
  };
  return { commitment: new SendCommitment({ unitOfWork }), calls, units, recorded };
};

/** The agent's notices as a pending first reply reads them, its default language English. */
const NOTICES: EmailFirstReplyNoticeFacts = {
  notices: normalizePrivacyNotices({
    en: { text: "We use your messages to answer you.", url: "https://example.com/privacy" },
    it: { text: "Usiamo i tuoi messaggi per risponderti.", url: "https://example.com/it/privacy" },
  }),
  defaultLocale: "en",
};
const NOTICE = NOTICES.notices.en;

/** An operator's resend of the message, after every send of it before. */
const resendIntent = async (h: Harness): Promise<EmailSendIntentRecord> => {
  const { intent } = await h.intents.materialize({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
    workspaceId: SEND_IDS.workspace,
    mailboxId: h.mailbox.id,
    conversationId: SEND_IDS.conversation,
    messageId: SEND_IDS.message,
    heldReplyId: null,
    idempotencyKey: `email:send:msg:${SEND_IDS.message}:resend:1`,
    authorKind: "operator",
    trigger: "audited_resend",
    authority: { policyVersion: h.mailbox.policyVersion, ownershipVersion: 0, mode: "operator_only", domainId: h.domain.id },
    provider: "resend",
    suppliedRfcMessageId: rfcMessageId("<aaaaaaaa-aaaa-4aaa-8aaa-000000000002@customer.test>"),
  });
  return intent;
};

/** An operator reply's intent, materialized and not yet frozen. */
const operatorIntent = async (h: Harness): Promise<EmailSendIntentRecord> => {
  const { intent } = await h.intents.materialize({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    workspaceId: SEND_IDS.workspace,
    mailboxId: h.mailbox.id,
    conversationId: SEND_IDS.conversation,
    messageId: SEND_IDS.message,
    heldReplyId: null,
    idempotencyKey: `email:send:msg:${SEND_IDS.message}`,
    authorKind: "operator",
    trigger: "operator_reply",
    authority: { policyVersion: h.mailbox.policyVersion, ownershipVersion: 0, mode: "operator_only", domainId: h.domain.id },
    provider: "resend",
    suppliedRfcMessageId: rfcMessageId("<aaaaaaaa-aaaa-4aaa-8aaa-000000000001@customer.test>"),
  });
  return intent;
};

/** An automatic reply's intent on an `auto` mailbox, as its materialization recorded it. */
const autoIntent = async (h: Harness): Promise<EmailSendIntentRecord> => {
  h.mailboxes.seed({ ...h.mailbox, engagementMode: "auto" });
  expect(await h.materializeAuto(SEND_IDS.heldReply)).toEqual({ ok: true, messageId: SEND_IDS.autoMessage });
  return h.onlyIntent();
};

describe("SendCommitment", () => {
  it("checks an automatic send's authority and freezes it in one unit, locking in the conversation lock protocol's order", async () => {
    const h = createSendPathHarness();
    const intent = await autoIntent(h);
    const { commitment, calls, units } = recordingCommitment(h);

    const committed = await commitment.commit(intent);

    expect(committed).toMatchObject({ outcome: "frozen", intent: { id: intent.id, version: intent.version + 1 } });
    expect(calls).toEqual(["conversation+ownership", "mailbox", "domain", "thread", "freeze"]);
    expect(units.opened).toBe(1);
    expect(h.driver.send).not.toHaveBeenCalled();
  });

  it("locks no conversation for an operator-authorized send, whose authority reads only what the mailbox may send as", async () => {
    const h = createSendPathHarness();
    h.owners.set(SEND_IDS.conversation, { state: "human_owned", version: 3 });
    const { commitment, calls } = recordingCommitment(h);

    expect(await commitment.commit(await operatorIntent(h))).toMatchObject({ outcome: "frozen" });
    expect(calls).toEqual(["mailbox", "domain", "thread", "freeze"]);
  });

  it.each([
    ["a takeover", (h: Harness) => h.owners.set(SEND_IDS.conversation, { state: "human_owned", version: 1 }), "human_owned"],
    ["a downgrade", (h: Harness) => h.mailboxes.seed({ ...h.mailbox, engagementMode: "draft", policyVersion: h.mailbox.policyVersion + 1 }), "policy_changed"],
    ["a mailbox removal", (h: Harness) => h.mailboxes.seed({ ...h.mailbox, engagementMode: "auto", removedAt: h.clock() }), "mailbox_removed"],
  ] as const)("refuses an automatic send, freezing nothing, when %s committed before its commitment", async (_label, revoke, code) => {
    const h = createSendPathHarness();
    const intent = await autoIntent(h);
    revoke(h);
    const { commitment, calls } = recordingCommitment(h);

    const committed = await commitment.commit(intent);

    expect(committed).toEqual({ outcome: "refused", refusal: code === "mailbox_removed"
      ? { verdict: "halt", haltReason: "mailbox_removed" }
      : { verdict: "revoked", code } });
    expect(calls).not.toContain("freeze");
    expect(h.onlyIntent()).toMatchObject({ state: "queued", request: null, version: intent.version });
  });

  it("halts an operator-authorized send, freezing nothing, when its domain stopped being verified before its commitment", async () => {
    const h = createSendPathHarness();
    const intent = await operatorIntent(h);
    h.domains.seed({ ...h.domain, sendingStatus: "pending" });
    const { commitment, calls } = recordingCommitment(h);

    expect(await commitment.commit(intent)).toEqual({ outcome: "refused", refusal: { verdict: "halt", haltReason: "sending_not_verified" } });
    expect(calls).not.toContain("freeze");
  });

  it("sends the agent's privacy notice, word for word, below a conversation's first reply, and records its version (#1545)", async () => {
    const h = createSendPathHarness();
    const intent = await operatorIntent(h);
    const { commitment, calls, recorded } = recordingCommitment(h, { pendingNotices: NOTICES });

    const committed = await commitment.commit(intent);

    expect(committed).toMatchObject({ outcome: "frozen" });
    expect(h.onlyIntent().request?.body?.text).toBe(
      "Your order ships on Monday.\n\nWe use your messages to answer you.\nhttps://example.com/privacy",
    );
    expect(recorded).toEqual([{ conversationId: SEND_IDS.conversation, version: NOTICE.version }]);
    // The conversation row is the protocol's first lock; the record writes the row it already holds.
    expect(calls).toEqual(["conversation", "mailbox", "domain", "thread", "freeze", "notice_recorded"]);
  });

  it("locks the conversation once for an automatic first reply, before its ownership", async () => {
    const h = createSendPathHarness();
    const intent = await autoIntent(h);
    const { commitment, calls } = recordingCommitment(h, { pendingNotices: NOTICES });

    expect(await commitment.commit(intent)).toMatchObject({ outcome: "frozen" });
    expect(calls).toEqual(["conversation", "conversation+ownership", "mailbox", "domain", "thread", "freeze", "notice_recorded"]);
  });

  it("sends a reply as written once the conversation has had its notice", async () => {
    const h = createSendPathHarness();
    const intent = await operatorIntent(h);
    const { commitment, recorded } = recordingCommitment(h);

    await commitment.commit(intent);

    expect(h.onlyIntent().request?.body?.text).toBe("Your order ships on Monday.");
    expect(recorded).toEqual([]);
  });

  it("records no notice for a send it refuses", async () => {
    const h = createSendPathHarness();
    const intent = await operatorIntent(h);
    h.domains.seed({ ...h.domain, sendingStatus: "pending" });
    const { commitment, recorded } = recordingCommitment(h, { pendingNotices: NOTICES });

    expect(await commitment.commit(intent)).toMatchObject({ outcome: "refused" });
    expect(recorded).toEqual([]);
  });

  it("sends the notice in the language the agent's reply was written in, else in the agent's default language (#1545)", async () => {
    const italian = createSendPathHarness();
    italian.messages.set(SEND_IDS.message, { ...italian.messages.get(SEND_IDS.message)!, content: "Spediamo lunedì.", replyLanguageTag: "it" });
    const inItalian = recordingCommitment(italian, { pendingNotices: NOTICES });

    await inItalian.commitment.commit(await operatorIntent(italian));

    expect(italian.onlyIntent().request?.body?.text).toBe(
      "Spediamo lunedì.\n\nUsiamo i tuoi messaggi per risponderti.\nhttps://example.com/it/privacy",
    );
    expect(inItalian.recorded).toEqual([{ conversationId: SEND_IDS.conversation, version: NOTICES.notices.it.version }]);

    // A teammate's own reply was written in no language the agent recorded: the agent's default.
    const untagged = createSendPathHarness();
    const inDefault = recordingCommitment(untagged, { pendingNotices: { ...NOTICES, defaultLocale: "it" } });
    await inDefault.commitment.commit(await operatorIntent(untagged));
    expect(inDefault.recorded).toEqual([{ conversationId: SEND_IDS.conversation, version: NOTICES.notices.it.version }]);
  });

  it("sends an operator's resend as its message's last frozen send went, notice included, and records nothing again (#1545)", async () => {
    const h = createSendPathHarness();
    await recordingCommitment(h, { pendingNotices: NOTICES }).commitment.commit(await operatorIntent(h));
    const resend = await resendIntent(h);
    // The first send recorded the notice, so none is pending for the resend.
    const resending = recordingCommitment(h);

    expect(await resending.commitment.commit(resend)).toMatchObject({ outcome: "frozen" });

    const [sent, resent] = await h.intents.listByMessageId(SEND_IDS.message);
    expect(resent?.request?.body).toEqual(sent?.request?.body);
    expect(resent?.request?.body?.text).toContain(NOTICE.text);
    expect(resending.recorded).toEqual([]);
  });

  it("renders a resend whose message never froze a send as a first reply, notice and record included", async () => {
    const h = createSendPathHarness();
    await operatorIntent(h);
    const resend = await resendIntent(h);
    const resending = recordingCommitment(h, { pendingNotices: NOTICES });

    await resending.commitment.commit(resend);

    expect((await h.intents.listByMessageId(SEND_IDS.message))[1]?.request?.body?.text).toContain(NOTICE.text);
    expect(resending.recorded).toEqual([{ conversationId: SEND_IDS.conversation, version: NOTICE.version }]);
  });

  it("reports the intent as another claim left it when that claim froze it first", async () => {
    const h = createSendPathHarness();
    const intent = await operatorIntent(h);
    const { commitment } = recordingCommitment(h);
    const first = await commitment.commit(intent);
    expect(first).toMatchObject({ outcome: "frozen" });

    const second = await commitment.commit(intent);

    expect(second).toMatchObject({ outcome: "moved", current: { id: intent.id, version: intent.version + 1 } });
  });
});
