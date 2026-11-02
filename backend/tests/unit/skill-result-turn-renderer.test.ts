import { describe, expect, it, vi } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { AGENT_SKILL_OUTCOME_KIND } from "../../src/modules/chat/composition.js";
import { buildChatTurnRuntime, type ChatTurnRuntimeDependencies } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { cappedSkillFindings } from "../../src/modules/chat/services/skillResultTurnRenderer.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import {
  GenericTurnOutcomeRenderer,
  TurnOutcomeRendererRegistry,
  type TurnOutcome,
  type TurnRenderContext,
  type TurnStreamResult,
} from "../../src/modules/chat/services/turnOutcome.js";
import type { SkillOutcome } from "../../src/modules/skills/public.js";
import { CHAT_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

const TOOL_TEXT = [
  "Ananda Edizioni publishes [Autobiografia di uno Yogi](https://example.com/autobiografia).",
  "",
  JSON.stringify({
    conversationId: "conversation-9",
    answerCoverage: { status: "answered" },
    ownership: { owner: "agent" },
    traceId: "trace-9",
  }, null, 2),
].join("\n");
const MODEL_REPLY = "We publish [Autobiografia di uno Yogi](https://example.com/autobiografia), a classic on yoga.";
const DIRECTIVE_ACTION = "Ask the publishing catalog and tell the user what it found.";

const session = (): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Claudio", chatModelOverride: null },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  userMessage: { id: "message-1", content: "Which books do you publish on yoga?" },
  effectiveQuery: "Which books do you publish on yoga?",
  history: [],
  turnRoute: "retrieval",
  retrieval: { responseIdentity: null, responseSettings: { customInstruction: "Help visitors find Ananda books." } },
  resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
  directiveSteering: {
    rules: [{ action: DIRECTIVE_ACTION, source: "directive", lifespan: "response" }],
    omissions: [],
    matches: [],
  },
} as unknown as PreparedSession);

const agentSkillOutcome = (over: Partial<SkillOutcome> = {}, kind = AGENT_SKILL_OUTCOME_KIND): TurnOutcome => ({
  kind,
  skillName: "ananda_edizioni",
  outcome: { status: "completed", answer: TOOL_TEXT, ...over },
  stagedContext: [],
  steering: [],
  trace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
});

const harness = (
  reply = MODEL_REPLY,
  options: { logger?: ChatTurnRuntimeDependencies["logger"] } = {},
) => {
  const calls: ChatGatewayInput[] = [];
  const chatGateway: ChatGateway = {
    async answer(input) {
      calls.push(input);
      return reply;
    },
    async *streamAnswer(input) {
      calls.push(input);
      yield reply.slice(0, 10);
      yield reply.slice(10);
    },
  };
  const fallbackReplyComposer: FallbackReplyComposer = {
    composeNoContext: vi.fn(async () => ({ text: "I could not find that.", declineReason: "content_gap" as const })),
  };
  const runtime = buildChatTurnRuntime({
    chatGateway,
    fallbackReplyComposer,
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    logger: options.logger,
  });
  const ctx: TurnRenderContext = { session: session(), query: "Which books do you publish on yoga?" };
  return { calls, renderer: runtime.skillResultRenderer, ctx };
};

const drain = async (stream: AsyncGenerator<string, TurnStreamResult>) => {
  const chunks: string[] = [];
  let step = await stream.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await stream.next();
  }
  return { chunks, result: step.value };
};

describe("skill result turn renderer", () => {
  it("has the agent's model write the reply from the skill's text, carried as findings", async () => {
    const { calls, renderer, ctx } = harness();

    const presentation = await renderer.render(agentSkillOutcome(), ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain(`<skill_findings>\n${TOOL_TEXT}\n</skill_findings>`);
    expect(calls[0]?.prompt).toContain(DIRECTIVE_ACTION);
    expect(calls[0]?.usageContext.attemptKey).toBe("skill_result");
    expect(presentation.answer).toBe(MODEL_REPLY);
  });

  it("presents the reply under the bound skill, the identity its turn always recorded", async () => {
    const { renderer, ctx } = harness();

    const presentation = await renderer.render(agentSkillOutcome(), ctx);

    expect(presentation).toMatchObject({
      skillName: "ananda_edizioni",
      skillOutcome: "completed",
      skillStatus: "completed",
    });
  });

  it("streams the reply as the agent's model writes it", async () => {
    const { calls, renderer, ctx } = harness();

    const { chunks, result } = await drain(renderer.stream!(agentSkillOutcome(), ctx));

    expect(chunks).toEqual([MODEL_REPLY.slice(0, 10), MODEL_REPLY.slice(10)]);
    expect(calls[0]?.prompt).toContain(`<skill_findings>\n${TOOL_TEXT}\n</skill_findings>`);
    expect(calls[0]?.usageContext.attemptKey).toBe("stream_skill_result");
    expect(result).toMatchObject({
      deliveryMode: "live",
      hasStreamedAnswer: true,
      finalPresentation: {
        answer: MODEL_REPLY,
        skillName: "ananda_edizioni",
        skillOutcome: "completed",
        skillStatus: "completed",
      },
    });
  });

  it("claims only completed agent-skill outcomes that carry text", () => {
    const { renderer } = harness();

    expect(renderer.supports(agentSkillOutcome())).toBe(true);
    expect(renderer.supports(agentSkillOutcome({ status: "failed", answer: "The tool returned an error." }))).toBe(false);
    expect(renderer.supports(agentSkillOutcome({ status: "failed", answer: undefined, outputs: { reason: "suppressed_for_safe_test" } }))).toBe(false);
    expect(renderer.supports(agentSkillOutcome({ answer: "  \n " }))).toBe(false);
    expect(renderer.supports(agentSkillOutcome({ answer: undefined }))).toBe(false);
    expect(renderer.supports(agentSkillOutcome({}, "direct"))).toBe(false);
  });

  it("leaves failed and empty outcomes to the generic renderer", () => {
    const { renderer } = harness();
    const generic = new GenericTurnOutcomeRenderer();
    const registry = new TurnOutcomeRendererRegistry([renderer, generic]);

    expect(registry.resolve(agentSkillOutcome())).toBe(renderer);
    expect(registry.resolve(agentSkillOutcome({ status: "failed", answer: "The tool returned an error." }))).toBe(generic);
    expect(registry.resolve(agentSkillOutcome({ answer: "" }))).toBe(generic);
  });

  it("keeps the direct reply on its own prompt, without a findings block", async () => {
    const { calls, ctx } = harness();
    const runtime = buildChatTurnRuntime({
      chatGateway: {
        async answer(input) {
          calls.push(input);
          return "Hello!";
        },
        async *streamAnswer() {
          yield "Hello!";
        },
      },
      fallbackReplyComposer: { composeNoContext: vi.fn() },
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
      quickReplyLaneEnabled: false,
    });
    const direct = runtime.turnSkills.find((skill) => skill.definition.outcomeKinds?.includes("direct"));

    await direct!.renderer.render({ ...agentSkillOutcome({}, "direct"), skillName: "assistant.direct" }, ctx);

    expect(calls[0]?.usageContext.attemptKey).toBe("direct");
    expect(calls[0]?.prompt).toContain("For route type `direct`");
    expect(calls[0]?.prompt).not.toContain("skill_findings");
  });
});

describe("skill result findings cap", () => {
  const ids = { skillName: "ananda_edizioni", workspaceId: "workspace-1", conversationId: "conversation-1" };
  const cap = CHAT_BEHAVIOR.skillResult.maxFindingsCodePoints;

  it("leaves findings under the cap unchanged and logs nothing", () => {
    const findings = "a".repeat(cap - 1);
    const logger = { debug: vi.fn() };

    const result = cappedSkillFindings(findings, ids, logger);

    expect(result).toBe(findings);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("leaves findings exactly at the cap unchanged and logs nothing", () => {
    const findings = "a".repeat(cap);
    const logger = { debug: vi.fn() };

    const result = cappedSkillFindings(findings, ids, logger);

    expect(result).toBe(findings);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("truncates findings over the cap to exactly the cap in code points, logging ids and sizes only", () => {
    const findings = "a".repeat(cap + 500);
    const logger = { debug: vi.fn() };

    const result = cappedSkillFindings(findings, ids, logger);

    expect(Array.from(result)).toHaveLength(cap);
    expect(result).toBe("a".repeat(cap));
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      event: "chat.skill_result.findings_truncated",
      skillName: ids.skillName,
      workspaceId: ids.workspaceId,
      conversationId: ids.conversationId,
      originalCodePoints: cap + 500,
      cap,
    });
    expect(typeof message).toBe("string");
    // Never the findings text itself.
    expect(JSON.stringify(fields)).not.toContain("aaaa");
  });

  it("never splits a surrogate pair at the cap boundary", () => {
    const findings = `${"a".repeat(cap - 1)}\u{1F600}extra`;

    const result = cappedSkillFindings(findings, ids);

    expect(Array.from(result)).toHaveLength(cap);
    expect(result.endsWith("\u{1F600}")).toBe(true);
    // No lone surrogate at the very end of the truncated string.
    expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false);
  });

  it("works when no logger is supplied", () => {
    const findings = "a".repeat(cap + 1);

    expect(() => cappedSkillFindings(findings, ids)).not.toThrow();
  });

  it("caps the skill's findings before they enter the reply prompt", async () => {
    const longFindings = "a".repeat(cap + 500);
    const logger = { debug: vi.fn() };
    const { calls, renderer, ctx } = harness(MODEL_REPLY, { logger });

    await renderer.render(agentSkillOutcome({ answer: longFindings }), ctx);

    const match = calls[0]?.prompt.match(/<skill_findings>\n([\s\S]*)\n<\/skill_findings>/);
    expect(match?.[1]).toHaveLength(cap);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
