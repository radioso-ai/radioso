import request from "supertest";
import { describe, expect, it } from "vitest";

import { CHAT_MESSAGE_MAX_LENGTH } from "../../src/app/http/schemas/textInputLimits.js";
import { createA2aTestApp, openA2aAgent, rpc, sendText, type A2aTestApp } from "../support/a2aTestApp.js";

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";

const a2aErrorBody = (id: string | number | null, code: number, reason: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message: expect.any(String), data: [{ "@type": ERROR_INFO, reason, domain: "a2a-protocol.org", metadata: {} }] },
});

const setUp = async (): Promise<{ ctx: A2aTestApp; publicId: string }> => {
  const ctx = createA2aTestApp();
  const { publicId } = await openA2aAgent(ctx);
  return { ctx, publicId };
};

describe("A2A JSON-RPC binding contract (FR-010 to FR-014)", () => {
  it("serves SendMessage, GetTask, ListTasks and CancelTask as JSON-RPC 2.0 over application/json (FR-010, FR-011)", async () => {
    const { ctx, publicId } = await setUp();

    const sent = await sendText(ctx, publicId, "Hello").expect(200);
    const contextId = sent.body.result.message.contextId as string;
    const listed = await rpc(ctx, publicId, "ListTasks", { contextId }).expect(200);
    const got = await rpc(ctx, publicId, "GetTask", { id: "AAAAAAAAAAAAAAAAAAAAAA" }).expect(200);
    const canceled = await rpc(ctx, publicId, "CancelTask", { id: "AAAAAAAAAAAAAAAAAAAAAA" }).expect(200);

    expect(sent.headers["content-type"]).toMatch(/^application\/json/u);
    expect(sent.body).toMatchObject({ jsonrpc: "2.0", id: "req-1", result: { message: { role: "ROLE_AGENT" } } });
    expect(listed.body).toEqual({ jsonrpc: "2.0", id: "req-1", result: { tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 } });
    expect(got.body).toEqual(a2aErrorBody("req-1", -32001, "TASK_NOT_FOUND"));
    expect(canceled.body).toEqual(a2aErrorBody("req-1", -32001, "TASK_NOT_FOUND"));
  });

  it("answers the streaming methods and the extended card with -32004, push configs with -32003, and the rest with -32601 (FR-011)", async () => {
    const { ctx, publicId } = await setUp();
    const expectations: Array<[string, number, string]> = [
      ["SendStreamingMessage", -32004, "UNSUPPORTED_OPERATION"],
      ["SubscribeToTask", -32004, "UNSUPPORTED_OPERATION"],
      ["GetExtendedAgentCard", -32004, "UNSUPPORTED_OPERATION"],
      ["CreateTaskPushNotificationConfig", -32003, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["GetTaskPushNotificationConfig", -32003, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["ListTaskPushNotificationConfigs", -32003, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["DeleteTaskPushNotificationConfig", -32003, "PUSH_NOTIFICATION_NOT_SUPPORTED"],
      ["message/send", -32601, "METHOD_NOT_FOUND"],
      ["tasks/get", -32601, "METHOD_NOT_FOUND"],
    ];
    for (const [method, code, reason] of expectations) {
      const response = await rpc(ctx, publicId, method, {}, { id: 4 }).expect(200);
      expect(response.body).toEqual(a2aErrorBody(4, code, reason));
    }
  });

  it("answers a batch, and anything that is not one JSON-RPC 2.0 request, with -32600 (FR-011)", async () => {
    const { ctx, publicId } = await setUp();
    const post = () => request(ctx.app).post(`/a2a/${publicId}`).set("A2A-Version", "1.0").set("Content-Type", "application/json");

    const batch = await post().send([{ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }]).expect(200);
    const wrongVersion = await post().send({ jsonrpc: "1.0", id: 2, method: "GetTask", params: { id: "x" } }).expect(200);
    const notification = await post().send({ jsonrpc: "2.0", method: "GetTask", params: { id: "x" } }).expect(200);

    expect(batch.body).toEqual(a2aErrorBody(null, -32600, "INVALID_REQUEST"));
    expect(wrongVersion.body).toEqual(a2aErrorBody(2, -32600, "INVALID_REQUEST"));
    expect(notification.body).toEqual(a2aErrorBody(null, -32600, "INVALID_REQUEST"));
  });

  it("answers a body that is not JSON with -32700, and a body that is not application/json with -32005", async () => {
    const { ctx, publicId } = await setUp();

    const malformed = await request(ctx.app).post(`/a2a/${publicId}`).set("A2A-Version", "1.0")
      .set("Content-Type", "application/json").send("{\"jsonrpc\": \"2.0\", ").expect(200);
    const plainText = await request(ctx.app).post(`/a2a/${publicId}`).set("A2A-Version", "1.0")
      .set("Content-Type", "text/plain").send("SendMessage").expect(200);

    expect(malformed.body).toEqual(a2aErrorBody(null, -32700, "PARSE_ERROR"));
    expect(plainText.body).toEqual(a2aErrorBody(null, -32005, "CONTENT_TYPE_NOT_SUPPORTED"));
  });

  it("accepts A2A-Version 1.0 only; an absent header means 0.3 and answers -32009 (FR-012)", async () => {
    const { ctx, publicId } = await setUp();

    for (const version of [null, "0.3", "1.1", "2.0"]) {
      const response = await rpc(ctx, publicId, "GetTask", { id: "x" }, { version }).expect(200);
      expect(response.body).toEqual(a2aErrorBody("req-1", -32009, "VERSION_NOT_SUPPORTED"));
    }
  });

  it("carries a google.rpc.ErrorInfo in every error, and no message text, ids or identity (FR-013)", async () => {
    const { ctx, publicId } = await setUp();
    const forgedContext = "Zm9yZ2VkLWNvbnRleHQtdGhhdC1jYW5ub3Qtb3Blbg";

    const response = await sendText(ctx, publicId, "My card number is 4111 1111 1111 1111", {
      messageId: "client-message-123",
      contextId: forgedContext,
    }).expect(200);

    expect(response.body.error).toEqual({
      code: -32602,
      message: expect.any(String),
      data: [{ "@type": ERROR_INFO, reason: "CONTEXT_NOT_FOUND", domain: "radioso.ai", metadata: {} }],
    });
    const serialized = JSON.stringify(response.body.error);
    for (const leaked of ["4111", "client-message-123", forgedContext, publicId]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("takes text parts only, answering -32005 for file, raw, url or data parts (FR-014)", async () => {
    const { ctx, publicId } = await setUp();

    for (const part of [{ raw: "aGVsbG8=" }, { url: "https://files.example/a.pdf" }, { data: { orderId: 7 } }]) {
      const response = await rpc(ctx, publicId, "SendMessage", {
        message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "See attached" }, part] },
      }).expect(200);
      expect(response.body).toEqual(a2aErrorBody("req-1", -32005, "CONTENT_TYPE_NOT_SUPPORTED"));
    }
  });

  it("bounds a message like a chat message, and answers params that do not fit with -32602 (FR-014)", async () => {
    const { ctx, publicId } = await setUp();

    const tooLong = await sendText(ctx, publicId, "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1)).expect(200);
    const noMessageId = await rpc(ctx, publicId, "SendMessage", { message: { role: "ROLE_USER", parts: [{ text: "Hi" }] } }).expect(200);
    const pageTooBig = await rpc(ctx, publicId, "ListTasks", { pageSize: 101 }).expect(200);

    for (const response of [tooLong, noMessageId, pageTooBig]) {
      expect(response.body).toEqual(a2aErrorBody("req-1", -32602, "INVALID_PARAMS"));
    }
  });

  it("answers an unknown agent with the card's 404, before any method runs (FR-010)", async () => {
    const { ctx } = await setUp();

    const response = await sendText(ctx, "ag_doesnotexistdoesnotexist", "Hello");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});
