import { describe, expect, it } from "vitest";

import { parseCallParams } from "../../../src/modules/a2a/domain/requestParams.js";

const LIMITS = { maxMessageLength: 40 };

const message = (overrides: Record<string, unknown> = {}) => ({
  messageId: "m-1",
  role: "ROLE_USER",
  parts: [{ text: "Where is my order?" }],
  ...overrides,
});

const send = (params: Record<string, unknown>) => parseCallParams("SendMessage", params, LIMITS);

const failure = (result: ReturnType<typeof parseCallParams>) => {
  if (result.ok) throw new Error("expected a refusal");
  return { code: result.error.code, reason: result.error.reason };
};

describe("SendMessage params", () => {
  it("reads one text message, with its ids and history length", () => {
    expect(send({ message: message({ contextId: "ctx", taskId: "task" }), configuration: { historyLength: 3 } })).toEqual({
      ok: true,
      input: {
        method: "SendMessage",
        params: { messageId: "m-1", text: "Where is my order?", contextId: "ctx", taskId: "task", historyLength: 3 },
      },
    });
  });

  it("joins several text parts and treats empty ProtoJSON strings as absent", () => {
    expect(send({ message: message({ parts: [{ text: "One" }, { text: "two", mediaType: "text/plain" }], contextId: "", taskId: "" }) }))
      .toMatchObject({ ok: true, input: { params: { text: "One\ntwo", contextId: null, taskId: null, historyLength: null } } });
  });

  it("accepts returnImmediately and acceptedOutputModes and changes nothing for them", () => {
    expect(send({ message: message(), configuration: { returnImmediately: true, acceptedOutputModes: ["application/json"] } }))
      .toMatchObject({ ok: true, input: { params: { text: "Where is my order?" } } });
  });

  it("answers -32005 for a file, raw, url, or data part", () => {
    for (const part of [{ raw: "aGVsbG8=" }, { url: "https://files.example/a.pdf" }, { data: { a: 1 } }]) {
      expect(failure(send({ message: message({ parts: [{ text: "see" }, part] }) })))
        .toEqual({ code: -32005, reason: "CONTENT_TYPE_NOT_SUPPORTED" });
    }
  });

  it("answers -32602 for a part with no content, or with two", () => {
    expect(failure(send({ message: message({ parts: [{}] }) }))).toEqual({ code: -32602, reason: "INVALID_PARAMS" });
    expect(failure(send({ message: message({ parts: [{ text: "a", url: "https://x.example" }] }) })))
      .toEqual({ code: -32602, reason: "INVALID_PARAMS" });
  });

  it("answers -32602 for a missing messageId, an agent-role message, no parts, or a blank message", () => {
    expect(failure(send({ message: message({ messageId: undefined }) }))).toMatchObject({ code: -32602 });
    expect(failure(send({ message: message({ role: "ROLE_AGENT" }) }))).toMatchObject({ code: -32602 });
    expect(failure(send({ message: message({ parts: [] }) }))).toMatchObject({ code: -32602 });
    expect(failure(send({ message: message({ parts: [{ text: "   " }] }) }))).toMatchObject({ code: -32602 });
    expect(failure(send({}))).toMatchObject({ code: -32602 });
  });

  it("bounds the message like a chat message", () => {
    expect(failure(send({ message: message({ parts: [{ text: "x".repeat(41) }] }) }))).toEqual({ code: -32602, reason: "INVALID_PARAMS" });
    expect(send({ message: message({ parts: [{ text: "x".repeat(40) }] }) })).toMatchObject({ ok: true });
  });

  it("answers -32003 for a push notification config, since the card declares none", () => {
    expect(failure(send({ message: message(), configuration: { taskPushNotificationConfig: { url: "https://hooks.example" } } })))
      .toEqual({ code: -32003, reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" });
  });

  it("answers -32602 for a negative history length", () => {
    expect(failure(send({ message: message(), configuration: { historyLength: -1 } }))).toMatchObject({ code: -32602 });
  });
});

describe("GetTask, CancelTask and ListTasks params", () => {
  it("reads a task id and an optional history length", () => {
    expect(parseCallParams("GetTask", { id: "task-1", historyLength: 0 }, LIMITS))
      .toEqual({ ok: true, input: { method: "GetTask", params: { id: "task-1", historyLength: 0 } } });
    expect(parseCallParams("CancelTask", { id: "task-1" }, LIMITS)).toEqual({ ok: true, input: { method: "CancelTask", params: { id: "task-1" } } });
    expect(failure(parseCallParams("GetTask", {}, LIMITS))).toMatchObject({ code: -32602 });
  });

  it("reads the list filters and defaults the page size to 50", () => {
    expect(parseCallParams("ListTasks", {
      contextId: "ctx",
      status: "TASK_STATE_INPUT_REQUIRED",
      pageSize: 10,
      pageToken: "tok",
      historyLength: 2,
      statusTimestampAfter: "2026-11-09T10:00:00Z",
      includeArtifacts: true,
    }, LIMITS)).toEqual({
      ok: true,
      input: {
        method: "ListTasks",
        params: {
          contextId: "ctx",
          state: "input_required",
          pageSize: 10,
          pageToken: "tok",
          historyLength: 2,
          statusTimestampAfter: new Date("2026-11-09T10:00:00Z"),
          includeArtifacts: true,
        },
      },
    });
    expect(parseCallParams("ListTasks", {}, LIMITS)).toEqual({
      ok: true,
      input: {
        method: "ListTasks",
        params: {
          contextId: null,
          state: null,
          pageSize: 50,
          pageToken: null,
          historyLength: null,
          statusTimestampAfter: null,
          includeArtifacts: false,
        },
      },
    });
  });

  it("answers -32602 for a page size outside 1-100, an unknown state, or an unreadable timestamp", () => {
    expect(failure(parseCallParams("ListTasks", { pageSize: 101 }, LIMITS))).toMatchObject({ code: -32602 });
    expect(failure(parseCallParams("ListTasks", { pageSize: -1 }, LIMITS))).toMatchObject({ code: -32602 });
    expect(failure(parseCallParams("ListTasks", { status: "done" }, LIMITS))).toMatchObject({ code: -32602 });
    expect(failure(parseCallParams("ListTasks", { statusTimestampAfter: "yesterday" }, LIMITS))).toMatchObject({ code: -32602 });
  });

  it("reads TASK_STATE_UNSPECIFIED and a zero page size as unset, as ProtoJSON defaults", () => {
    expect(parseCallParams("ListTasks", { status: "TASK_STATE_UNSPECIFIED", pageSize: 0 }, LIMITS))
      .toMatchObject({ ok: true, input: { params: { state: null, pageSize: 50 } } });
  });
});
