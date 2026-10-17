import { describe, expect, it } from "vitest";

import {
  defaultConversationDataErasers,
  defaultVerifiedCustomerDataErasers,
  defaultVisitorKeyDataErasers,
} from "../../src/app/composition/conversationErasure.js";
import { ConversationAuditEraser } from "../../src/db/repositories/auditEventRepository.js";
import { ContextVariableValueEraser } from "../../src/db/repositories/contextVariableRepository.js";
import { EmailSkillActivityEraser } from "../../src/db/repositories/emailSkillActivityRepository.js";
import { EmailInboundEraser } from "../../src/modules/emailChannel/public.js";
import { EvalConversationEraser } from "../../src/modules/eval/composition.js";
import type { ConversationErasureScope } from "../../src/shared/domain/conversationDataErasure.js";
import { createRecordingKysely, type RecordedAnswer } from "../support/recordingKysely.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

const conversations = (conversationIds: string[] = [conversationId]): ConversationErasureScope => ({
  kind: "conversations",
  workspaceId,
  conversationIds,
});
const workspace: ConversationErasureScope = { kind: "workspace", workspaceId };

/** A recording database that answers each statement by the first matching rule. */
const recording = (rules: [RegExp, RecordedAnswer][] = []) =>
  createRecordingKysely(({ sql }) => rules.find(([pattern]) => pattern.test(sql))?.[1] ?? { changed: 1 });

describe("ContextVariableValueEraser", () => {
  it("erases, in one statement, the session values of chat sessions only the erased conversations carry", async () => {
    const { db, statements } = recording();

    expect(await new ContextVariableValueEraser(db).erase(conversations())).toBe(1);

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toMatch(/^delete from "context_variable_values"/u);
    expect(statements[0].sql).toMatch(/"anonymous_session_id"/u);
    expect(statements[0].sql).toMatch(/not exists/u);
    expect(statements[0].parameters).toContain("session");
  });

  it("sends nothing when no conversation goes, or for a workspace, whose values cascade with its variables", async () => {
    const { db, statements } = recording();
    const eraser = new ContextVariableValueEraser(db);

    expect(await eraser.erase(conversations([]))).toBe(0);
    expect(await eraser.erase(workspace)).toBe(0);
    expect(statements).toEqual([]);
  });

  it("erases a verified customer's own values", async () => {
    const { db, statements } = recording();

    await new ContextVariableValueEraser(db).eraseVerifiedCustomer({ workspaceId, verifiedCustomerId: "customer-42" });

    expect(statements[0].parameters).toEqual([workspaceId, "customer", ["customer-42"]]);
  });
});

describe("ConversationAuditEraser", () => {
  it("erases the conversation's turn events, one statement per event type", async () => {
    const { db, statements } = recording();

    expect(await new ConversationAuditEraser(db).erase(conversations())).toBe(2);

    expect(statements.map((statement) => statement.parameters)).toEqual([
      [workspaceId, "chat.answer", "conversationId", [conversationId]],
      [workspaceId, "chat.suspended", "conversationId", [conversationId]],
    ]);
  });

  it("erases every turn event of a workspace about to be deleted, whose audit rows outlive it", async () => {
    const { db, statements } = recording();

    await new ConversationAuditEraser(db).erase(workspace);

    expect(statements.map((statement) => statement.parameters)).toEqual([
      [workspaceId, "chat.answer"],
      [workspaceId, "chat.suspended"],
    ]);
  });
});

describe("EmailSkillActivityEraser", () => {
  it("erases the conversations' activity, and leaves a workspace's to its cascade", async () => {
    const { db, statements } = recording();
    const eraser = new EmailSkillActivityEraser(db);

    expect(await eraser.erase(workspace)).toBe(0);
    expect(statements).toEqual([]);
    expect(await eraser.erase(conversations())).toBe(1);
    expect(statements[0].sql).toMatch(/^delete from "email_skill_activity"/u);
  });
});

describe("EmailInboundEraser", () => {
  it("erases the conversations' deliveries, then each settled event left with no delivery", async () => {
    const { db, statements } = recording([
      [/^delete from "email_inbound_deliveries"/u, { rows: [{ inbound_event_id: "event-1" }, { inbound_event_id: "event-1" }] }],
      [/^delete from "email_inbound_events"/u, { changed: 1 }],
    ]);

    expect(await new EmailInboundEraser(db).erase(conversations())).toBe(3);

    expect(statements[0].sql).toMatch(/"planned_conversation_id" = any/u);
    expect(statements[1].parameters).toEqual([["event-1"], "processed", "ignored", "failed"]);
  });

  it("sends no event delete when no delivery went", async () => {
    const { db, statements } = recording([[/^delete from "email_inbound_deliveries"/u, { rows: [] }]]);

    expect(await new EmailInboundEraser(db).erase(conversations())).toBe(0);
    expect(statements).toHaveLength(1);
  });
});

describe("EvalConversationEraser", () => {
  it("erases the revision results, runs and cases built on the conversations' snapshots", async () => {
    const { db, statements } = recording([
      [/^select "id" from "eval_snapshots"/u, { rows: [{ id: "snapshot-1" }] }],
      [/^select "id" from "eval_cases"/u, { rows: [{ id: "case-1" }] }],
    ]);

    expect(await new EvalConversationEraser(db).erase(conversations())).toBe(3);

    expect(statements.map((statement) => statement.sql.split(" where")[0])).toEqual([
      'select "id" from "eval_snapshots"',
      'select "id" from "eval_cases"',
      'delete from "revision_eval_run_cases"',
      'delete from "eval_runs"',
      'delete from "eval_cases"',
    ]);
  });

  it("stops after the snapshot read when the conversations were never kept as eval cases", async () => {
    const { db, statements } = recording([[/^select "id" from "eval_snapshots"/u, { rows: [] }]]);

    expect(await new EvalConversationEraser(db).erase(conversations())).toBe(0);
    expect(statements).toHaveLength(1);
  });

  it("clears a workspace's revision evals, runs and cases so its cascade is not held back", async () => {
    const { db, statements } = recording();

    await new EvalConversationEraser(db).erase(workspace);

    expect(statements.map((statement) => statement.sql.split(" where")[0])).toEqual([
      'delete from "revision_eval_runs"',
      'delete from "eval_runs"',
      'delete from "eval_cases"',
    ]);
  });
});

describe("default erasers", () => {
  it("registers one eraser per owning module", () => {
    const { db } = recording();

    expect(defaultConversationDataErasers.map((bind) => bind(db).owner)).toEqual([
      "context-variables",
      "audit",
      "email-channel",
      "customer-email",
      "eval",
      "whatsapp",
      "audience-pulse",
      "voice-channel",
    ]);
    expect(defaultVerifiedCustomerDataErasers.map((bind) => bind(db).owner)).toEqual(["context-variables"]);
    expect(defaultVisitorKeyDataErasers.map((bind) => bind(db).owner)).toEqual(["voice-channel"]);
  });
});
