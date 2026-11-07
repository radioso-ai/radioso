import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationModelRequest,
  PendingRenderableTurn,
  RenderableTurn,
  RoutineGroundedAnswerRenderer,
  RoutineStep,
  RoutineStepReplyInput,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineStepRenderer } from "../src/index.js";

const turn: TurnContext = {
  agent: { id: "a", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "alex@example.com" },
  history: [{ role: "assistant", content: "What is your email?" }],
  stagedContext: [],
  steering: [],
};
const askEmail: RoutineStep = { id: "ask_email", kind: "chat", action: "Ask the user for their email address." };
const stepSteering = [{ action: "Ask the user for their email address.", source: "routine" as const, lifespan: "response" as const }];
const stagedTurn: TurnContext = {
  ...turn,
  stagedContext: [{
    kind: "skill_result",
    source: "retrieval.context",
    data: { contexts: [{ documentId: "doc_1", title: "Course Guide", content: "Valmora is introduced in the first module." }] },
  }],
};

const pageEvidence = "<page_excerpt>Autumn retreat: 30 October to 2 November.</page_excerpt>";

const replyInputs: Array<{ name: string; input: RoutineStepReplyInput }> = [
  { name: "step reply", input: { step: askEmail, steering: stepSteering, turn } },
  { name: "re-ask", input: { step: askEmail, steering: stepSteering, turn, reask: { missingSlots: [{ id: "slot_email", key: "email", type: "email", required: true }], exhausted: true } } },
  { name: "cited step reply", input: { step: askEmail, steering: stepSteering, turn: stagedTurn } },
  { name: "step reply with context evidence", input: { step: askEmail, steering: stepSteering, turn, contextEvidence: [pageEvidence] } },
  {
    name: "handoff terminal",
    input: {
      step: { id: "handoff", kind: "terminal", action: "Bringing in a teammate.", metadata: { terminalKind: "handoff" } },
      steering: [],
      turn,
    },
  },
  { name: "stuck hand-off", input: { step: askEmail, steering: [], turn, stuckHandoff: true } },
];

/** A gateway answering `complete` with `text` and streaming it as `deltas`, recording each request. */
const gatewayFor = (text: string, deltas: string[][] = [[text]]) => {
  const requests: Array<{ via: "complete" | "stream"; request: ConversationModelRequest }> = [];
  const attempts = [...deltas];
  const gateway: ConversationModelGateway = {
    complete: vi.fn(async (request: ConversationModelRequest) => {
      requests.push({ via: "complete", request });
      return { text };
    }),
    stream: vi.fn(async function* (request: ConversationModelRequest) {
      requests.push({ via: "stream", request });
      for (const delta of attempts.shift() ?? []) {
        yield delta;
      }
    }),
  };
  return { gateway, requests };
};

const drain = async (stream: AsyncGenerator<string, RenderableTurn>): Promise<{ deltas: string[]; turn: RenderableTurn }> => {
  const deltas: string[] = [];
  let next = await stream.next();
  while (!next.done) {
    deltas.push(next.value);
    next = await stream.next();
  }
  return { deltas, turn: next.value };
};

describe("RoutineStepRenderer.prepare", () => {
  for (const { name, input } of replyInputs) {
    it(`makes no model call until the reply is asked for: ${name}`, () => {
      const { gateway } = gatewayFor("  Which email can we use?  ");

      new RoutineStepRenderer(gateway, { responseLanguage: "English" }).prepare(input);

      expect(gateway.complete).not.toHaveBeenCalled();
      expect(gateway.stream).not.toHaveBeenCalled();
    });

    it(`renders what render() renders, through the same model request: ${name}`, async () => {
      const viaRender = gatewayFor("  Which email can we use?  ");
      const viaPrepare = gatewayFor("  Which email can we use?  ");

      const rendered = await new RoutineStepRenderer(viaRender.gateway, { responseLanguage: "English" }).render(input);
      const prepared = await new RoutineStepRenderer(viaPrepare.gateway, { responseLanguage: "English" }).prepare(input).render();

      expect(prepared).toEqual(rendered);
      expect(viaPrepare.requests).toEqual(viaRender.requests);
    });
  }

  it("offers no stream for a hand-off message: it is only ever delivered whole", () => {
    const { gateway } = gatewayFor("A teammate takes it from here.");
    const renderer = new RoutineStepRenderer(gateway);

    expect(renderer.prepare(replyInputs.find((entry) => entry.name === "handoff terminal")!.input).stream).toBeUndefined();
    expect(renderer.prepare(replyInputs.find((entry) => entry.name === "stuck hand-off")!.input).stream).toBeUndefined();
  });

  it("offers no stream when the model gateway cannot stream", () => {
    const gateway: ConversationModelGateway = { complete: vi.fn(async () => ({ text: "ok" })) };

    expect(new RoutineStepRenderer(gateway).prepare({ step: askEmail, steering: stepSteering, turn }).stream).toBeUndefined();
  });

  it("hands a groundable step to the host's grounded answer without generating anything yet", async () => {
    const { gateway } = gatewayFor("generic reply");
    const groundedReply: PendingRenderableTurn = {
      render: vi.fn(async () => ({ answer: "Grounded reply." })),
      stream: vi.fn(),
    };
    const groundedAnswerRenderer: RoutineGroundedAnswerRenderer = {
      render: vi.fn(async () => ({ answer: "Grounded reply." })),
      prepare: vi.fn(() => groundedReply),
    };
    const input = { step: askEmail, steering: stepSteering, turn: stagedTurn };

    const reply = new RoutineStepRenderer(gateway, { groundedAnswerRenderer }).prepare(input);

    expect(groundedAnswerRenderer.prepare).toHaveBeenCalledWith(input);
    expect(reply).toBe(groundedReply);
    expect(groundedReply.render).not.toHaveBeenCalled();
    expect(groundedAnswerRenderer.render).not.toHaveBeenCalled();
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it("writes the step reply when the host's grounded answer declines the step", async () => {
    const { gateway } = gatewayFor("generic reply");
    const groundedAnswerRenderer: RoutineGroundedAnswerRenderer = {
      render: vi.fn(async () => null),
      prepare: vi.fn(() => null),
    };

    const reply = new RoutineStepRenderer(gateway, { groundedAnswerRenderer }).prepare({ step: askEmail, steering: stepSteering, turn });

    expect(reply.stream).toBeDefined();
    expect(await reply.render()).toEqual({ answer: "generic reply" });
    expect(groundedAnswerRenderer.render).not.toHaveBeenCalled();
  });

  it("renders whole when the host's grounded answer can only decide while rendering", async () => {
    const { gateway } = gatewayFor("generic reply");
    const groundedAnswerRenderer: RoutineGroundedAnswerRenderer = { render: vi.fn(async () => null) };

    const reply = new RoutineStepRenderer(gateway, { groundedAnswerRenderer }).prepare({ step: askEmail, steering: stepSteering, turn });

    expect(reply.stream).toBeUndefined();
    expect(groundedAnswerRenderer.render).not.toHaveBeenCalled();
    expect(await reply.render()).toEqual({ answer: "generic reply" });
    expect(groundedAnswerRenderer.render).toHaveBeenCalledOnce();
  });
});

describe("RoutineStepRenderer when the turn's operators cannot be reached (#1702)", () => {
  const FACT = "The team cannot be notified from this chat right now";
  const ending: RoutineStep = {
    id: "done",
    kind: "terminal",
    action: "Say the request was passed to reception.",
    metadata: { terminalKind: "complete" },
  };
  const endingSteering = [{ action: "Say the request was passed to reception.", source: "routine" as const, lifespan: "response" as const }];

  it("tells the step reply, after the step's instruction, and only when the fact holds", async () => {
    const told = gatewayFor("reply");
    await new RoutineStepRenderer(told.gateway).render({ step: ending, steering: endingSteering, turn, operatorsUnreachable: true });
    const prompt = told.requests[0].request.systemPrompt ?? "";
    expect(prompt).toContain(FACT);
    expect(prompt.indexOf(FACT)).toBeGreaterThan(prompt.indexOf("Say the request was passed to reception."));
    // The reply's language rule stays the last word, so the fact does not pull the language.
    expect(prompt.indexOf(FACT)).toBeLessThan(prompt.indexOf("Always reply in the same language"));
    // Only the team's notification failed: a booking a skill made this turn stays true to report.
    expect(prompt).toContain("Keep anything else the step instruction(s) say that is still true.");
    expect(prompt).not.toContain("passed to anyone");

    const untold = gatewayFor("reply");
    await new RoutineStepRenderer(untold.gateway).render({ step: ending, steering: endingSteering, turn });
    expect(untold.requests[0].request.systemPrompt).not.toContain(FACT);
  });

  it("streams the same told reply as it renders", async () => {
    const { gateway, requests } = gatewayFor("reply");
    const reply = new RoutineStepRenderer(gateway).prepare({ step: askEmail, steering: stepSteering, turn, operatorsUnreachable: true });
    const stream = reply.stream?.();
    let next = await stream?.next();
    while (next && !next.done) {
      next = await stream?.next();
    }
    expect(requests[0].request.systemPrompt).toContain(FACT);
  });

  it("hands the grounded answer the fact as one of the step's own rules, and leaves its input alone otherwise", () => {
    const { gateway } = gatewayFor("generic reply");
    const prepare = vi.fn<NonNullable<RoutineGroundedAnswerRenderer["prepare"]>>(() => ({ render: vi.fn() }));
    const renderer = new RoutineStepRenderer(gateway, { groundedAnswerRenderer: { render: vi.fn(), prepare } });

    renderer.prepare({ step: ending, steering: endingSteering, turn: stagedTurn, operatorsUnreachable: true });
    const [told] = prepare.mock.calls[0];
    expect(told.steering[0]).toEqual(endingSteering[0]);
    expect(told.steering[1]).toMatchObject({ source: "routine", lifespan: "response" });
    expect(told.steering[1].action).toContain(FACT);

    renderer.prepare({ step: ending, steering: endingSteering, turn: stagedTurn });
    expect(prepare.mock.calls[1][0].steering).toEqual(endingSteering);
  });

  it("gives a grounded answer that can only decide while rendering the same rule", async () => {
    const { gateway } = gatewayFor("generic reply");
    const render = vi.fn<RoutineGroundedAnswerRenderer["render"]>(async () => ({ answer: "Grounded." }));

    await new RoutineStepRenderer(gateway, { groundedAnswerRenderer: { render } })
      .prepare({ step: ending, steering: endingSteering, turn: stagedTurn, operatorsUnreachable: true })
      .render();

    expect(render.mock.calls[0][0].steering.at(-1)?.action).toContain(FACT);
  });

  it("tells the step reply once when the grounded answer declines the step", async () => {
    const { gateway, requests } = gatewayFor("generic reply");
    const groundedAnswerRenderer: RoutineGroundedAnswerRenderer = { render: vi.fn(async () => null), prepare: vi.fn(() => null) };

    await new RoutineStepRenderer(gateway, { groundedAnswerRenderer })
      .prepare({ step: ending, steering: endingSteering, turn, operatorsUnreachable: true })
      .render();

    const prompt = requests[0].request.systemPrompt ?? "";
    expect(prompt.split(FACT)).toHaveLength(2);
  });

  it.each([
    { name: "a hand-off terminal", input: { step: { ...ending, metadata: { terminalKind: "handoff" } }, steering: endingSteering, turn } },
    { name: "a stuck hand-off", input: { step: askEmail, steering: [], turn, stuckHandoff: true } },
  ])("keeps $name's wording: the conversation lands in the Inbox either way", async ({ input }) => {
    const told = gatewayFor("handoff");
    const untold = gatewayFor("handoff");

    await new RoutineStepRenderer(told.gateway).render({ ...input, operatorsUnreachable: true });
    await new RoutineStepRenderer(untold.gateway).render(input);

    expect(told.requests[0].request).toEqual(untold.requests[0].request);
  });
});

describe("RoutineStepRenderer streamed step reply", () => {
  it("streams the reply trimmed, and finishes with the turn render() would return", async () => {
    const input = { step: askEmail, steering: stepSteering, turn: stagedTurn };
    const streamed = gatewayFor("unused", [["  \n", " Which", " email", " ", "can we use?", "  \n"]]);
    const rendered = gatewayFor("  \n Which email can we use?  \n");

    const { deltas, turn: finished } = await drain(new RoutineStepRenderer(streamed.gateway).prepare(input).stream!());
    const expected = await new RoutineStepRenderer(rendered.gateway).render(input);

    expect(deltas.join("")).toBe("Which email can we use?");
    expect(deltas[0]).toBe("Which");
    expect(finished).toEqual(expected);
    expect(streamed.requests.map((entry) => entry.request)).toEqual(rendered.requests.map((entry) => entry.request));
  });

  it("streams a step reply that reads the context evidence beside the visitor's message, not in the system prompt", async () => {
    const { gateway, requests } = gatewayFor("unused", [["Is it the 30 October edition?"]]);

    await drain(
      new RoutineStepRenderer(gateway).prepare({ step: askEmail, steering: stepSteering, turn, contextEvidence: [pageEvidence] }).stream!(),
    );

    const [{ request }] = requests;
    expect(request.systemPrompt).not.toContain(pageEvidence);
    expect(request.messages.at(-2)?.content).toContain(pageEvidence);
    expect(request.messages.at(-1)).toEqual({ role: "user", content: turn.inputEvent.content });
  });

  it("retries a blank stream once, and shows only the retry", async () => {
    const { gateway, requests } = gatewayFor("unused", [[" ", "\n"], ["Which email?"]]);

    const { deltas, turn: finished } = await drain(
      new RoutineStepRenderer(gateway).prepare({ step: askEmail, steering: stepSteering, turn }).stream!(),
    );

    expect(deltas).toEqual(["Which email?"]);
    expect(finished).toEqual({ answer: "Which email?" });
    expect(requests.map((entry) => entry.via)).toEqual(["stream", "stream"]);
    expect(requests[1].request).toEqual(requests[0].request);
  });

  it("fails rather than reply with nothing when the retry is blank too", async () => {
    const { gateway } = gatewayFor("unused", [[""], ["  "]]);

    await expect(
      drain(new RoutineStepRenderer(gateway).prepare({ step: askEmail, steering: stepSteering, turn }).stream!()),
    ).rejects.toThrow("routine_step_reply_blank");
    expect(gateway.stream).toHaveBeenCalledTimes(2);
  });
});
