import { describe, expect, it, vi } from "vitest";

import { FetchWebhookHttpClient, WebhookResponseStatusError } from "../../src/shared/infra/http/signedWebhook.js";

const request = { url: "https://hooks.example/radioso", rawBody: "{}", headers: {} };

const answering = (status: number) => {
  const cancel = vi.fn(async () => undefined);
  const fetchImpl = vi.fn(async () => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), body: { cancel } }) as unknown as Response);
  return { fetchImpl, cancel };
};

describe("FetchWebhookHttpClient", () => {
  it("reports the accepting status, releases the unread body, and throws a non-2xx answer's status", async () => {
    const accepted = answering(202);
    await expect(new FetchWebhookHttpClient(async () => undefined, { fetchImpl: accepted.fetchImpl }).send(request)).resolves.toEqual({ status: 202 });
    expect(accepted.cancel).toHaveBeenCalledTimes(1);

    const refused = answering(503);
    await expect(new FetchWebhookHttpClient(async () => undefined, { fetchImpl: refused.fetchImpl }).post(request))
      .rejects.toBeInstanceOf(WebhookResponseStatusError);
  });

  it("counts a host lookup that hangs against the deadline", async () => {
    const { fetchImpl } = answering(200);
    const client = new FetchWebhookHttpClient(() => new Promise<void>(() => undefined), { fetchImpl, timeoutMs: 50 });

    await expect(client.send(request)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops when the caller's signal aborts", async () => {
    const { fetchImpl } = answering(200);
    const run = new AbortController();
    run.abort(new Error("run abandoned"));

    await expect(new FetchWebhookHttpClient(async () => undefined, { fetchImpl }).send({ ...request, signal: run.signal }))
      .rejects.toThrow("run abandoned");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
