import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";
import { EmailMailboxHarness, type ReviewTurnStub } from "../support/emailMailboxHarness.js";
import { createEmailChannelDatabase } from "./support/emailChannelHarness.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// The mailbox behaviour harness end to end, without a model: the real composition over a disposable
// database, a scripted review turn, and mail in through the signed webhook. This is the harness's
// own check, so the live behaviour suite (`pnpm run evals:email`) can trust what it reports.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const COVERED = "How much is standard shipping?";
const UNCOVERED = "Do you sell gift cards?";
const WANTS_A_PERSON = "I want to talk to a person.";
const ANSWER = "Standard shipping within the EU costs 4.90 EUR.";

/** The scripted turn: grounded for the covered question, ungrounded for the uncovered one, a hand-off otherwise. */
const script = (turns: string[]) => ({ customerText }: { customerText: string }): ReviewTurnStub => {
  turns.push(customerText);
  if (customerText.includes(COVERED)) return { kind: "draft", text: ANSWER, grounded: true };
  if (customerText.includes(UNCOVERED)) return { kind: "draft", text: "I can't confirm that.", grounded: false };
  return { kind: "no_draft", handoffReason: "customer_requested_human" };
};

describeIntegration("email mailbox harness (Postgres, scripted review turn)", () => {
  let suite: Awaited<ReturnType<typeof createEmailChannelDatabase>>;
  let spoolDir: string;
  let harness: EmailMailboxHarness;
  const turns: string[] = [];

  beforeAll(async () => {
    suite = await createEmailChannelDatabase(integrationDatabaseUrl, "mailbox_harness");
    spoolDir = await mkdtemp(join(tmpdir(), "email-mailbox-harness-"));
    const env = getEnv({
      NODE_ENV: "test",
      DATABASE_URL: suite.url,
      OPENAI_API_KEY: "test-key",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      WORKSPACE_TOKEN_SECRET: "fedcba9876543210fedcba9876543210",
      CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
      WORKER_DISPATCH_DRIVER: "noop",
      DOCUMENT_STORAGE_DRIVER: "local",
      DOCUMENT_STORAGE_LOCAL_PATH: join(spoolDir, "documents"),
      EMAIL_CHANNEL_PROVIDER: "local",
      EMAIL_CHANNEL_INBOUND_DOMAIN: "in.harness.test",
      EMAIL_CHANNEL_WEBHOOK_SECRET: "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=",
      EMAIL_CHANNEL_WORKERS_ENABLED: "true",
      EMAIL_CHANNEL_LOCAL_SPOOL_DIR: spoolDir,
      EMAIL_CHANNEL_COALESCE_SECONDS: "0",
    });
    harness = await EmailMailboxHarness.boot({
      env,
      company: { name: "Fernhill Tea", domain: "fernhill.test", operatorEmail: "olivia@fernhill.test", operatorName: "Olivia" },
      agent: { name: "Fernhill Support", instruction: "Answer from the documents." },
      reviewTurn: script(turns),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
    await rm(spoolDir, { recursive: true, force: true });
    await suite?.close();
  }, 30_000);

  it("sends a grounded answer on an auto mailbox, threaded and marked auto-generated", async () => {
    const mailbox = await harness.openMailbox({ mode: "auto", local: "auto-covered" });
    const receipt = await mailbox.inbound({ from: { address: "ana@customer.test", name: "Ana" }, subject: "Shipping", text: COVERED });
    await mailbox.settle();

    const outcome = await mailbox.outcome(receipt);
    expect(outcome).toMatchObject({ kind: "sent", reason: "auto", ownership: { state: "ai_owned" }, attentionKind: "none" });
    expect(outcome.sentEmail).toMatchObject({
      to: "ana@customer.test",
      subject: "Re: Shipping",
      text: ANSWER,
      autoSubmitted: "auto-generated",
      inReplyTo: receipt.messageId,
    });
    expect(await mailbox.spool()).toHaveLength(1);
  });

  it("holds an ungrounded draft on an auto mailbox and sends nothing", async () => {
    const mailbox = await harness.openMailbox({ mode: "auto", local: "auto-uncovered" });
    const receipt = await mailbox.inbound({ from: "ben@customer.test", subject: "Gift cards", text: UNCOVERED });
    await mailbox.settle();

    expect(await mailbox.outcome(receipt)).toMatchObject({
      kind: "drafted",
      reason: "outcome_not_publishable",
      heldReply: { state: "pending", labels: { grounding: "ungrounded" } },
      attentionKind: "approval",
    });
    expect(await mailbox.spool()).toEqual([]);
  });

  it("hands a draftless review to a person with the engine's reason", async () => {
    const mailbox = await harness.openMailbox({ mode: "auto", local: "auto-handoff" });
    const receipt = await mailbox.inbound({ from: "cleo@customer.test", subject: "Help", text: WANTS_A_PERSON });
    await mailbox.settle();

    expect(await mailbox.outcome(receipt)).toMatchObject({
      kind: "handed_off",
      reason: "customer_requested_human",
      ownership: { state: "human_owned", reason: "customer_requested_human" },
      attentionKind: "handoff",
    });
  });

  it("drops an out-of-office reply without a turn", async () => {
    const mailbox = await harness.openMailbox({ mode: "auto", local: "auto-ooo" });
    const before = turns.length;
    const receipt = await mailbox.inbound({
      from: "dan@customer.test",
      subject: "Out of office",
      text: COVERED,
      headers: { "Auto-Submitted": "auto-replied" },
    });
    await mailbox.settle();

    expect(await mailbox.outcome(receipt)).toMatchObject({ kind: "silent", reason: "automated_sender", conversationId: null });
    expect(turns.length).toBe(before);
  });

  it("holds every draft on a draft mailbox, and sends the released one", async () => {
    const mailbox = await harness.openMailbox({ mode: "draft", local: "draft-covered" });
    const receipt = await mailbox.inbound({ from: "eve@customer.test", subject: "Shipping", text: COVERED });
    await mailbox.settle();
    expect(await mailbox.outcome(receipt)).toMatchObject({
      kind: "drafted",
      reason: "draft_mode",
      heldReply: { labels: { grounding: "grounded", coverage: "answered" } },
    });
    expect(await mailbox.spool()).toEqual([]);

    await mailbox.release();
    await mailbox.settle();

    const released = await mailbox.outcome(receipt);
    expect(released).toMatchObject({ kind: "sent", reason: "operator_released", attentionKind: "none" });
    expect(released.sentEmail).toMatchObject({ text: ANSWER, autoSubmitted: "auto-generated" });
  });

  it("ingests mail on an operator-only mailbox for a person, without a turn", async () => {
    const mailbox = await harness.openMailbox({ mode: "operator_only", local: "operator-only" });
    const before = turns.length;
    const receipt = await mailbox.inbound({ from: "fay@customer.test", subject: "Shipping", text: COVERED });
    await mailbox.settle();

    expect(await mailbox.outcome(receipt)).toMatchObject({
      kind: "silent",
      reason: "operator_only_mailbox",
      ownership: { state: "human_owned", reason: "operator_only_mailbox" },
      attentionKind: "handoff",
    });
    expect(turns.length).toBe(before);
  });

  it("stays silent on a thread a teammate took over, and sends the teammate's own reply", async () => {
    const mailbox = await harness.openMailbox({ mode: "auto", local: "auto-takeover" });
    const first = await mailbox.inbound({ from: "gus@customer.test", subject: "Shipping", text: COVERED });
    await mailbox.settle();
    const answered = await mailbox.outcome(first);
    await mailbox.takeOver();
    const before = turns.length;

    const followUp = await mailbox.inbound({
      from: "gus@customer.test",
      subject: "Re: Shipping",
      text: "Thanks, and to Austria?",
      inReplyTo: answered.sentEmail!.messageId,
      references: [first.messageId, answered.sentEmail!.messageId],
    });
    await mailbox.settle();

    const outcome = await mailbox.outcome(followUp);
    expect(outcome).toMatchObject({ kind: "silent", reason: "human_owned", conversationId: answered.conversationId });
    expect(turns.length).toBe(before);

    await mailbox.operatorReply("Yes, the same price to Austria. Olivia");
    await mailbox.settle();
    const sent = await mailbox.spool();
    expect(sent).toHaveLength(2);
    expect(sent.find((email) => email.autoSubmitted === null)?.text).toContain("Olivia");
  });

  it("follows a mode change for mail accepted after it", async () => {
    const mailbox = await harness.openMailbox({ mode: "auto", local: "mode-change" });
    await mailbox.setMode("draft");
    const receipt = await mailbox.inbound({ from: "hal@customer.test", subject: "Shipping", text: COVERED });
    await mailbox.settle();

    expect(await mailbox.outcome(receipt)).toMatchObject({ kind: "drafted", reason: "draft_mode" });
  });
});
