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
    data: { contexts: [{ documentId: "doc_1", title: "Course Guide", content: "Kriya is introduced in the first module." }] },
  }],
};

const replyInputs: Array<{ name: string; input: RoutineStepReplyInput }> = [
  { name: "step reply", input: { step: askEmail, steering: stepSteering, turn } },
  { name: "re-ask", input: { step: askEmail, steering: stepSteering, turn, reask: { missingSlots: [{ id: "slot_email", key: "email", type: "email", required: true }], exhausted: true } } },
  { name: "cited step reply", input: { step: askEmail, steering: stepSteering, turn: stagedTurn } },
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
