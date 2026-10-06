import { describe, expect, it } from "vitest";

import { SendCommitment, type EmailSendCommitmentUnitOfWork } from "../../../src/modules/emailChannel/public.js";
import { rfcMessageId } from "../../../src/modules/mail/public.js";
import type { EmailSendIntentRecord } from "../../../src/modules/emailChannel/persistence/emailSendIntentRepository.js";
import { createSendPathHarness, SEND_IDS } from "../../support/inMemoryEmailSend.js";

type Harness = ReturnType<typeof createSendPathHarness>;

/**
 * The commitment over the harness's stores, recording every read and write its one unit makes, in
 * order, and how many units it opened.
 */
const recordingCommitment = (h: Harness) => {
  const calls: string[] = [];
  const units = { opened: 0 };
  const unitOfWork: EmailSendCommitmentUnitOfWork = {
    run: async (work) => {
      units.opened += 1;
      return work({
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
        },
      });
    },
  };
  return { commitment: new SendCommitment({ unitOfWork }), calls, units };
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
