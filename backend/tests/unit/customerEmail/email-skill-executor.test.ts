import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { RoutineInputBinding, RoutineState, TurnContext } from "@radioso/conversation-contract";
import { afterEach, describe, expect, it } from "vitest";

import {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  EmailSkillExecutor,
} from "../../../src/modules/customerEmail/executor/emailSkillExecutor.js";
import {
  RoutineSkillExecutorDispatcher,
  StaticRoutineSkillResolver,
} from "../../../src/modules/routines/skillDispatcher.js";
import { SkillExecutorRegistry, type SkillDefinition } from "../../../src/modules/skills/public.js";
import { initializeTracing, shutdownTracing } from "../../../src/shared/observability/tracing/index.js";
import type { CustomerEmailDeliveryResult } from "../../../src/modules/customerEmail/services/customerEmailDeliveryService.js";
import type { EmailSkillDefinitionRecord } from "../../../src/db/repositories/emailSkillDefinitionRepository.js";
import type { SkillInvocation } from "../../../src/modules/skills/public.js";

const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

const definition = (overrides: Partial<EmailSkillDefinitionRecord> = {}): EmailSkillDefinitionRecord => ({
  id: "skill-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  connectionId: "connection-1",
  skillName: "support_email_customer",
  mode: "draft",
  boundInputs: { subject: "Follow-up" },
  exposedInputs: {
    to: { slotBinding: "customerEmail" },
    bodyText: { slotBinding: "messageBody" },
  },
  enabled: true,
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
  updatedAt: new Date("2026-06-15T00:00:00.000Z"),
  ...overrides,
});

const dispatch = (
  executor: EmailSkillExecutor,
  collected: Record<string, unknown> = { customerEmail: "customer@example.com", messageBody: "Hello" },
  collectedOrigins?: SkillInvocation["collectedOrigins"],
) =>
  executor.dispatch({
    skill: { name: "support_email_customer" },
    collected,
    ...(collectedOrigins ? { collectedOrigins } : {}),
    context: { agentId: "agent-1", workspaceId: "workspace-1" },
    emit: noopEmit,
  });

const buildExecutor = (deliveryResult: CustomerEmailDeliveryResult, record: EmailSkillDefinitionRecord | null = definition()) => {
  const deliveryInputs: unknown[] = [];
  const activityInputs: unknown[] = [];
  const executor = new EmailSkillExecutor({
    skills: {
      findEnabledByName: async (workspaceId, agentId, skillName) =>
        record && workspaceId === record.workspaceId && agentId === record.agentId && skillName === record.skillName && record.enabled
          ? record
          : null,
    },
    delivery: {
      deliver: async (input) => {
        deliveryInputs.push(input);
        return deliveryResult;
      },
    },
    activity: {
      record: async (input) => {
        activityInputs.push(input);
      },
    },
  });
  return { executor, deliveryInputs, activityInputs };
};

describe("EmailSkillExecutor", () => {
  for (const outcome of ["drafted", "sent", "disabled_connection", "needs_reauth", "provider_rejected", "failed"] as const) {
    it(`returns the typed ${outcome} outcome from delivery`, async () => {
      const record = definition({ mode: outcome === "sent" ? "send" : "draft" });
      const { executor, deliveryInputs } = buildExecutor({ outcome, errorCode: outcome === "failed" ? "provider_failed" : undefined }, record);

      const result = await dispatch(executor);

      expect(result.disposition).toBe("settled");
      if (result.disposition === "settled") {
        expect(result.outcome.status).toBe(outcome);
        expect(result.outcome.outputs).not.toHaveProperty("bodyText");
      }
      expect(deliveryInputs).toHaveLength(1);
      expect(deliveryInputs[0]).toMatchObject({
        workspaceId: "workspace-1",
        connectionId: "connection-1",
        mode: record.mode,
        message: {
          to: "customer@example.com",
          subject: "Follow-up",
          bodyText: "Hello",
        },
      });
    });
  }

  it("returns missing_input without calling delivery when required exposed values are absent", async () => {
    const { executor, deliveryInputs, activityInputs } = buildExecutor({ outcome: "drafted" });

    const result = await dispatch(executor, { customerEmail: "customer@example.com" });

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "missing_input", outputs: { missingInputs: ["bodyText"] } },
    });
    expect(deliveryInputs).toHaveLength(0);
    expect(activityInputs).toEqual([
      expect.objectContaining({
        skillDefinitionId: "skill-1",
        connectionId: "connection-1",
        outcome: "missing_input",
        errorCode: "missing_input",
      }),
    ]);
  });

  it("records sanitized activity through the activity sink", async () => {
    const { executor, activityInputs } = buildExecutor({ outcome: "failed", errorCode: "provider_failed" });

    await dispatch(executor, {
      customerEmail: "Customer Person <customer@example.com>",
      messageBody: "This full body must not be retained",
    });

    expect(activityInputs).toHaveLength(1);
    expect(activityInputs[0]).toMatchObject({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      skillDefinitionId: "skill-1",
      connectionId: "connection-1",
      skillName: "support_email_customer",
      mode: "draft",
      outcome: "failed",
      errorCode: "provider_failed",
      recipientSummary: {
        toCount: 1,
        ccCount: 0,
        domains: ["example.com"],
        redactedRecipients: ["c***@example.com"],
      },
    });
    expect(JSON.stringify(activityInputs[0])).not.toContain("This full body must not be retained");
  });

  it("fails closed for undefined or disabled skill names", async () => {
    const { executor } = buildExecutor({ outcome: "drafted" }, definition({ enabled: false }));

    const result = await dispatch(executor);

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "failed", outputs: { reason: "skill_not_found" } },
    });
  });
});

describe("EmailSkillExecutor bodyHtml origins", () => {
  // Every character HTML escaping has to handle: tag brackets, both quote styles, and ampersand.
  const visitorMarkup = `<a href='x' title="y">hi & bye</a><script>`;
  const escapedMarkup = "&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;hi &amp; bye&lt;/a&gt;&lt;script&gt;";

  const htmlDefinition = (overrides: Partial<EmailSkillDefinitionRecord> = {}) =>
    definition({
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
        bodyHtml: { slotBinding: "note" },
      },
      ...overrides,
    });

  const deliveredMessage = async (
    collected: Record<string, unknown>,
    collectedOrigins: SkillInvocation["collectedOrigins"],
    record: EmailSkillDefinitionRecord = htmlDefinition(),
  ) => {
    const { executor, deliveryInputs } = buildExecutor({ outcome: "drafted" }, record);
    await dispatch(executor, collected, collectedOrigins);
    expect(deliveryInputs).toHaveLength(1);
    return (deliveryInputs[0] as { message: { bodyHtml: string | null; bodyText: string | null } }).message;
  };

  it("escapes a bodyHtml a routine slot filled", async () => {
    const message = await deliveredMessage(
      { customerEmail: "customer@example.com", note: visitorMarkup },
      { customerEmail: "slot", note: "slot" },
    );

    expect(message.bodyHtml).toBe(escapedMarkup);
  });

  it("escapes a bodyHtml a turn context variable filled", async () => {
    const message = await deliveredMessage(
      { customerEmail: "customer@example.com", note: visitorMarkup },
      { customerEmail: "literal", note: "context" },
    );

    expect(message.bodyHtml).toBe(escapedMarkup);
  });

  it("sends a bodyHtml the author wrote as a literal binding as written", async () => {
    const message = await deliveredMessage(
      { customerEmail: "customer@example.com", note: "<p>Thanks for <b>writing</b> in.</p>" },
      { customerEmail: "slot", note: "literal" },
    );

    expect(message.bodyHtml).toBe("<p>Thanks for <b>writing</b> in.</p>");
  });

  it("sends bodyHtml as written when the dispatch carries no origins", async () => {
    const message = await deliveredMessage(
      { customerEmail: "customer@example.com", note: "<p>Model-filled</p>" },
      undefined,
    );

    expect(message.bodyHtml).toBe("<p>Model-filled</p>");
  });

  it("sends a bodyHtml the skill definition binds as written", async () => {
    const message = await deliveredMessage(
      { customerEmail: "customer@example.com", bodyHtml: visitorMarkup },
      { customerEmail: "slot", bodyHtml: "slot" },
      definition({
        boundInputs: { subject: "Follow-up", bodyHtml: "<p>Fixed <b>body</b></p>" },
        exposedInputs: { to: { slotBinding: "customerEmail" } },
      }),
    );

    expect(message.bodyHtml).toBe("<p>Fixed <b>body</b></p>");
  });

  it("leaves a slot-filled bodyText unchanged, since it is plain text", async () => {
    const message = await deliveredMessage(
      { customerEmail: "customer@example.com", messageBody: visitorMarkup },
      { customerEmail: "slot", messageBody: "slot" },
      definition(),
    );

    expect(message.bodyText).toBe(visitorMarkup);
  });

  describe("tracing", () => {
    class RecordingExporter implements SpanExporter {
      readonly spans: ReadableSpan[] = [];

      export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
        this.spans.push(...spans);
        callback({ code: 0 });
      }

      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    }

    afterEach(async () => {
      await shutdownTracing();
    });

    it("marks the dispatch span when it escapes bodyHtml, without recording the body", async () => {
      const exporter = new RecordingExporter();
      initializeTracing({
        enabled: true,
        environment: "test",
        otlpEndpoint: "http://localhost:4318/v1/traces",
        runtimeRole: "api",
        serviceName: "radioso-api",
        spanExporter: exporter,
      });

      await deliveredMessage(
        { customerEmail: "customer@example.com", note: visitorMarkup },
        { customerEmail: "slot", note: "slot" },
      );

      const span = exporter.spans.find((candidate) => candidate.name === "customer_email.skill.dispatch");
      expect(span?.attributes).toMatchObject({ "customer_email.html_escaped": true });
      expect(JSON.stringify(span?.attributes)).not.toContain("hi &");
    });
  });
});

describe("EmailSkillExecutor behind a routine skill step", () => {
  const routineState = (variables: Record<string, unknown>): RoutineState => ({
    sessionId: "conversation-1",
    routineId: "follow_up",
    path: ["collect", "send_email"],
    variables,
    status: "active",
  });

  const turn = {
    agent: { id: "agent-1" },
    sessionId: "conversation-1",
    stagedContext: [],
  } as unknown as TurnContext;

  const dispatchStep = async (
    variables: Record<string, unknown>,
    inputBindings?: Record<string, RoutineInputBinding>,
  ) => {
    const { executor, deliveryInputs } = buildExecutor(
      { outcome: "drafted" },
      definition({
        exposedInputs: {
          to: { slotBinding: "customerEmail" },
          bodyHtml: { slotBinding: "note" },
        },
      }),
    );
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter: CUSTOMER_EMAIL_SKILLS_ADAPTER, executor });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        { name: "support_email_customer", execution: { kind: "internal", adapter: CUSTOMER_EMAIL_SKILLS_ADAPTER } } as unknown as SkillDefinition,
      ]),
      registry,
      { workspaceId: "workspace-1" },
    );
    await dispatcher.dispatch({ skillName: "support_email_customer", state: routineState(variables), turn, inputBindings });
    expect(deliveryInputs).toHaveLength(1);
    return (deliveryInputs[0] as { message: { bodyHtml: string | null } }).message.bodyHtml;
  };

  it("escapes visitor markup a typed step binds from a routine variable", async () => {
    const bodyHtml = await dispatchStep(
      { email: "customer@example.com", visitorNote: '<a href="x">hi</a><script>' },
      {
        customerEmail: { kind: "variableRef", ref: "email" },
        note: { kind: "variableRef", ref: "visitorNote" },
      },
    );

    expect(bodyHtml).toBe("&lt;a href=&quot;x&quot;&gt;hi&lt;/a&gt;&lt;script&gt;");
  });

  it("sends markup a typed step binds as a literal as written", async () => {
    const bodyHtml = await dispatchStep(
      { email: "customer@example.com" },
      {
        customerEmail: { kind: "variableRef", ref: "email" },
        note: { kind: "literal", value: "<p>We got your <b>request</b>.</p>" },
      },
    );

    expect(bodyHtml).toBe("<p>We got your <b>request</b>.</p>");
  });

  it("escapes visitor markup an untyped step passes through from routine variables", async () => {
    const bodyHtml = await dispatchStep({ customerEmail: "customer@example.com", note: "<script>alert(1)</script>" });

    expect(bodyHtml).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
