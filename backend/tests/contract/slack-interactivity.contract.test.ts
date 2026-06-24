import { createHmac } from "node:crypto";
import { STATUS_CODES } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createSlackInteractivityRouter } from "../../src/modules/slack/operator/slackInteractivityRouter.js";
import type { SlackViewSubmissionResponse } from "../../src/modules/slack/public.js";

const signingSecret = "test-signing-secret";
const nowMs = Date.parse("2026-06-23T12:00:00.000Z");

const createSignedHeaders = (body: string, timestamp = Math.floor(nowMs / 1000).toString()) => {
  const base = `v0:${timestamp}:${body}`;
  return {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`,
  };
};

const createRouter = () => {
  const handler = {
    handleBlockActions: vi.fn(async () => undefined),
    handleViewSubmission: vi.fn(async (): Promise<SlackViewSubmissionResponse | undefined> => undefined),
    handleViewClosed: vi.fn(async () => undefined),
  };
  const router = createSlackInteractivityRouter({
    signingSecret,
    now: () => nowMs,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    handler,
  });
  return { router, handler };
};

const formBody = (payload: unknown): string =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

const invokeRouter = async (
  router: ReturnType<typeof createSlackInteractivityRouter>,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown; text: string }> =>
  new Promise((resolve, reject) => {
    const lowerHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const req: {
      method: string;
      url: string;
      originalUrl: string;
      headers: Record<string, string>;
      rawBody: Buffer;
      body: Record<string, string>;
      header(name: string): string | undefined;
    } = {
      method: "POST",
      url: "/interactivity",
      originalUrl: "/interactivity",
      headers: {
        ...lowerHeaders,
        "content-type": "application/x-www-form-urlencoded",
      },
      rawBody: Buffer.from(body),
      body: Object.fromEntries(new URLSearchParams(body)),
      header(name: string): string | undefined {
        return this.headers[name.toLowerCase()];
      },
    };
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      text: "",
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        this.body = value;
        this.text = JSON.stringify(value);
        resolve({ status: this.statusCode, body: this.body, text: this.text });
      },
      sendStatus(code: number) {
        this.statusCode = code;
        this.text = STATUS_CODES[code] ?? String(code);
        resolve({ status: this.statusCode, body: undefined, text: this.text });
      },
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name: string) {
        return this.headers[name.toLowerCase()];
      },
      end(value?: string) {
        if (value) {
          this.text = value;
        }
        resolve({ status: this.statusCode, body: this.body, text: this.text });
      },
    };
    const routerWithHandle = router as unknown as {
      handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
    };
    routerWithHandle.handle(req, res, (error: unknown) => {
      if (error) {
        reject(error);
      }
    });
  });

describe("Slack interactivity contract", () => {
  it("verifies the Slack signature, parses urlencoded payload, routes block actions, and fast-acks", async () => {
    const { router, handler } = createRouter();
    const payload = {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      actions: [{ action_id: "decision_resolve", value: "{}" }],
    };
    const body = formBody(payload);

    const response = await invokeRouter(router, body, createSignedHeaders(body));

    expect(response.status).toBe(200);
    expect(response.text).toBe("OK");
    expect(handler.handleBlockActions).toHaveBeenCalledWith(payload);
  });

  it("acks a block action before the (possibly slow) handler completes", async () => {
    // A decision click resumes a routine (model calls) that can exceed Slack's ~3s ack window.
    // The route must ack BEFORE awaiting the handler — guard against a re-introduced await.
    let releaseHandler: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = {
      handleBlockActions: vi.fn(() => blocked),
      handleViewSubmission: vi.fn(async () => undefined),
      handleViewClosed: vi.fn(async () => undefined),
    };
    const router = createSlackInteractivityRouter({
      signingSecret,
      now: () => nowMs,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      handler,
    });
    const body = formBody({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      actions: [{ action_id: "decision_resolve", value: "{}" }],
    });

    const response = await invokeRouter(router, body, createSignedHeaders(body));

    expect(response.status).toBe(200);
    expect(handler.handleBlockActions).toHaveBeenCalled();
    releaseHandler();
  });

  it("routes view submissions with the handler response body and view closed callbacks", async () => {
    const { router, handler } = createRouter();
    handler.handleViewSubmission.mockResolvedValueOnce({
      response_action: "errors",
      errors: { ownership_reply_message: "Enter a reply." },
    });
    const submissionBody = formBody({ type: "view_submission", team: { id: "T1" }, user: { id: "U1" } });
    const closedBody = formBody({ type: "view_closed", team: { id: "T1" }, user: { id: "U1" } });

    const submissionResponse = await invokeRouter(router, submissionBody, createSignedHeaders(submissionBody));
    expect((await invokeRouter(router, closedBody, createSignedHeaders(closedBody))).status).toBe(200);

    expect(submissionResponse.status).toBe(200);
    expect(submissionResponse.body).toEqual({
      response_action: "errors",
      errors: { ownership_reply_message: "Enter a reply." },
    });
    expect(handler.handleViewSubmission).toHaveBeenCalledTimes(1);
    expect(handler.handleViewClosed).toHaveBeenCalledTimes(1);
  });

  it("rejects forged and stale signatures before routing", async () => {
    const { router, handler } = createRouter();
    const body = formBody({ type: "block_actions" });

    const forged = await invokeRouter(router, body, {
      ...createSignedHeaders(body),
      "X-Slack-Signature": "v0=bad",
    });
    const stale = await invokeRouter(
      router,
      body,
      createSignedHeaders(body, String(Math.floor(nowMs / 1000) - 301)),
    );

    expect(forged.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(handler.handleBlockActions).not.toHaveBeenCalled();
  });

  it("rejects malformed callback payloads", async () => {
    const { router, handler } = createRouter();
    const body = new URLSearchParams({ payload: "not-json" }).toString();

    const response = await invokeRouter(router, body, createSignedHeaders(body));

    expect(response.status).toBe(400);
    expect(handler.handleBlockActions).not.toHaveBeenCalled();
  });
});
