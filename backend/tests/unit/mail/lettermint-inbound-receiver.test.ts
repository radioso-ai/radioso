import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type LettermintFetch } from "../../../src/modules/mail/adapters/lettermintApi.js";
import {
  InboundFetchError,
  LettermintApiClient,
  LettermintInboundEmailReceiver,
} from "../../../src/modules/mail/public.js";

const LETTERMINT_FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/lettermint/", import.meta.url));
const PROJECT_TOKEN = "lm_project_SECRET_0123456789";
const TEAM_TOKEN = "lm_team_SECRET_9876543210";
const SIGNING_SECRET = "whsec_currentLettermintSigningSecret0000";
const MESSAGE_ID = "6b1f0c2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const MESSAGE_URL = `https://api.lettermint.co/v1/messages/${MESSAGE_ID}`;
const SOURCE_URL = `${MESSAGE_URL}/source`;

const fixtureJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${LETTERMINT_FIXTURES}${path}`, "utf8")) as Record<string, unknown>;
const recordedSource = (): Buffer => readFileSync(`${LETTERMINT_FIXTURES}api/get-message-source.inbound.eml`);

const inboundRecord = (edit?: (record: Record<string, unknown>) => void): Record<string, unknown> => {
  const record = fixtureJson("api/get-message.inbound.json");
  edit?.(record);
  return record;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const rfc822 = (raw: Buffer, status = 200): Response =>
  new Response(new Uint8Array(raw), { status, headers: { "content-type": "message/rfc822" } });

interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  projectToken: string | null;
  signal: AbortSignal | null;
}

const fakeLettermint = (respond: (url: string) => Response | Promise<Response>) => {
  const calls: RecordedCall[] = [];
  const fetch: LettermintFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      projectToken: headers.get("x-lettermint-token"),
      signal: init.signal ?? null,
    });
    return respond(url);
  };
  return { calls, fetch };
};

const receiverFor = (fetch: LettermintFetch, timeoutMs?: number) =>
  new LettermintInboundEmailReceiver({
    api: new LettermintApiClient({ projectToken: PROJECT_TOKEN, teamToken: TEAM_TOKEN, fetch, timeoutMs }),
    signingSecrets: { current: SIGNING_SECRET, previous: null },
  });

const answering = (options: { record?: Record<string, unknown>; source?: Buffer } = {}) =>
  fakeLettermint((url) => (url === SOURCE_URL ? rfc822(options.source ?? recordedSource()) : json(options.record ?? inboundRecord())));

/** The recorded source with its header block replaced, body kept. */
const sourceWithHeaders = (headerLines: readonly string[]): Buffer => {
  const raw = recordedSource().toString("latin1");
  const body = raw.slice(raw.indexOf("\r\n\r\n"));
  const kept = raw
    .slice(0, raw.indexOf("\r\n\r\n"))
    .split(/\r\n(?![ \t])/)
    .filter((line) => !/^(authentication-results|received):/i.test(line));
  return Buffer.from([...headerLines, ...kept].join("\r\n") + body, "latin1");
};

const fetchFailure = async (receiver: LettermintInboundEmailReceiver): Promise<unknown> =>
  receiver.fetchMessage(MESSAGE_ID).catch((error: unknown) => error);

const unusedFetch: LettermintFetch = async () => {
  throw new Error("verify must not call the provider");
};

describe("Lettermint inbound receiver: identity and verification", () => {
  const receiver = receiverFor(unusedFetch);

  it("names itself the lettermint provider", () => {
    expect(receiver.provider).toBe("lettermint");
  });

  it("verifies webhooks with the Lettermint signature scheme", () => {
    const body = Buffer.from(readFileSync(`${LETTERMINT_FIXTURES}webhooks/message.inbound.json`));
    const timestamp = 1759415400;
    const signature = createHmac("sha256", SIGNING_SECRET).update(`${timestamp}.`).update(body).digest("hex");

    const result = receiver.verify({
      rawBody: body,
      headers: { "x-lettermint-signature": `t=${timestamp},v1=${signature}`, "x-lettermint-delivery": String(timestamp) },
      now: new Date(timestamp * 1000),
    });

    expect(result).toMatchObject({ ok: true, event: { kind: "message_received", providerObjectId: MESSAGE_ID } });
  });

  it("rejects an unsigned webhook", () => {
    const result = receiver.verify({ rawBody: Buffer.from("{}"), headers: {}, now: new Date() });

    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("Lettermint inbound receiver: content fetch", () => {
  it("reads the message record, then its raw source, with the team token", async () => {
    const provider = answering();

    await receiverFor(provider.fetch).fetchMessage(MESSAGE_ID);

    expect(provider.calls.map(({ method, url, authorization, projectToken }) => ({ method, url, authorization, projectToken }))).toEqual([
      { method: "GET", url: MESSAGE_URL, authorization: `Bearer ${TEAM_TOKEN}`, projectToken: null },
      { method: "GET", url: SOURCE_URL, authorization: `Bearer ${TEAM_TOKEN}`, projectToken: null },
    ]);
    expect(provider.calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it("encodes the provider id into the request paths", async () => {
    const provider = fakeLettermint((url) => (url.endsWith("/source") ? rfc822(recordedSource()) : json(inboundRecord())));

    await receiverFor(provider.fetch).fetchMessage("a/../b?c");

    expect(provider.calls.map((call) => call.url)).toEqual([
      "https://api.lettermint.co/v1/messages/a%2F..%2Fb%3Fc",
      "https://api.lettermint.co/v1/messages/a%2F..%2Fb%3Fc/source",
    ]);
  });

  it("normalizes the raw source byte for byte", async () => {
    const message = await receiverFor(answering().fetch).fetchMessage(MESSAGE_ID);

    expect(message.raw.equals(recordedSource())).toBe(true);
    expect(message.rfcMessageId).toBe("<abc123@mail.example.test>");
    expect(message.from).toEqual({ address: "customer@example.test", displayName: "John Doe" });
    expect(message.subject).toBe("Question about my order");
    expect(message.text).toContain("recent order");
  });

  it("adds the message record's recipients to the delivered-to set", async () => {
    const record = inboundRecord((value) => {
      value.bcc = [{ email: "hidden@in.relay.test", name: null, sandbox_result: null }];
    });

    const message = await receiverFor(answering({ record }).fetch).fetchMessage(MESSAGE_ID);

    expect(message.deliveredTo).toEqual(expect.arrayContaining(["t_9f3c2a7b@in.relay.test", "hidden@in.relay.test"]));
  });
});

describe("Lettermint inbound receiver: authentication results", () => {
  const authenticationOf = async (source: Buffer) =>
    (await receiverFor(answering({ source }).fetch).fetchMessage(MESSAGE_ID)).authentication;

  it("trusts only the topmost lettermint.mx header, not a forged one below it", async () => {
    expect(await authenticationOf(recordedSource())).toEqual({ spf: "fail", dkim: "gray", dmarc: "fail" });
  });

  it("trusts no lettermint.mx header below one another authserv-id added on top", async () => {
    const source = sourceWithHeaders([
      "Authentication-Results: mx.upstream.test; spf=fail; dkim=fail; dmarc=fail",
      "Authentication-Results: lettermint.mx; spf=pass smtp.mailfrom=example.test; dkim=pass; dmarc=pass",
    ]);

    expect(await authenticationOf(source)).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });

  it.each([
    ["pass", "pass"],
    ["fail", "fail"],
    ["softfail", "fail"],
    ["policy", "fail"],
    ["neutral", "gray"],
    ["none", "gray"],
    ["temperror", "processing_failed"],
    ["permerror", "processing_failed"],
    ["something-new", "unknown"],
  ])("maps the result %s to %s", async (result, verdict) => {
    const source = sourceWithHeaders([`Authentication-Results: lettermint.mx; spf=${result}; dkim=${result}; dmarc=${result}`]);

    expect(await authenticationOf(source)).toEqual({ spf: verdict, dkim: verdict, dmarc: verdict });
  });

  it("reads folded headers, comments, versions and quoted properties", async () => {
    const source = sourceWithHeaders([
      "Authentication-Results: Lettermint.MX 1 (receiver; comments) ;",
      "\tspf (sender (nested) permitted) = pass smtp.mailfrom=\"odd;value\"@example.test;",
      " dkim/1=pass header.d=example.test;",
      " dmarc=fail (p=reject) header.from=example.test",
    ]);

    expect(await authenticationOf(source)).toEqual({ spf: "pass", dkim: "pass", dmarc: "fail" });
  });

  it("passes DKIM when any signature passed", async () => {
    const source = sourceWithHeaders([
      "Authentication-Results: lettermint.mx; dkim=fail header.d=example.test; dkim=pass header.d=mailer.example.test",
    ]);

    expect(await authenticationOf(source)).toEqual({ spf: "unknown", dkim: "pass", dmarc: "unknown" });
  });

  it.each([
    ["no Authentication-Results header", []],
    ["only another authserv-id's header", ["Authentication-Results: mx.attacker.test; spf=pass; dkim=pass; dmarc=pass"]],
    ["a no-result header", ["Authentication-Results: lettermint.mx; none"]],
  ])("reads %s as unknown", async (_label, headers) => {
    expect(await authenticationOf(sourceWithHeaders(headers))).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });

  it("ignores an Authentication-Results header inside the body", async () => {
    const raw = sourceWithHeaders([]).toString("latin1") + "\r\nAuthentication-Results: lettermint.mx; spf=pass; dkim=pass; dmarc=pass\r\n";

    expect(await authenticationOf(Buffer.from(raw, "latin1"))).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });
});

describe("Lettermint inbound receiver: spam verdict", () => {
  it.each([[1.2], [5], [12.5], [null], [undefined]])(
    "leaves the verdict to the route's quarantine, whatever spam_score %s says",
    async (score) => {
      const record = inboundRecord((value) => {
        if (score === undefined) delete value.spam_score;
        else value.spam_score = score;
      });

      const message = await receiverFor(answering({ record }).fetch).fetchMessage(MESSAGE_ID);

      expect(message.spamVerdict).toBe("unknown");
    },
  );
});

describe("Lettermint inbound receiver: fetch failures", () => {
  const recordFailing = (response: () => Response) =>
    receiverFor(fakeLettermint((url) => (url === SOURCE_URL ? rfc822(recordedSource()) : response())).fetch);
  const sourceFailing = (response: () => Response) =>
    receiverFor(fakeLettermint((url) => (url === SOURCE_URL ? response() : json(inboundRecord()))).fetch);

  it.each([
    [401, { message: "Unauthenticated." }, false, "provider_auth_failed"],
    [403, fixtureJson("api/error.forbidden.json"), false, "provider_auth_failed"],
    [404, { message: "Not found" }, false, "message_not_found"],
    [422, { message: "alice@customer.test is invalid" }, false, "provider_rejected"],
    [429, fixtureJson("api/error.rate-limited.json"), true, "provider_rate_limited"],
    [500, { error: { code: "SERVER_ERROR", message: "boom" } }, true, "provider_unavailable"],
    [503, {}, true, "provider_unavailable"],
  ])("classifies a %s on the message record", async (status, body, retryable, code) => {
    const failure = await fetchFailure(recordFailing(() => json(body, status)));

    expect(failure).toBeInstanceOf(InboundFetchError);
    expect(failure).toMatchObject({ retryable, code });
  });

  it.each([
    [410, false, "raw_expired"],
    [404, false, "message_not_found"],
    [401, false, "provider_auth_failed"],
    [429, true, "provider_rate_limited"],
    [502, true, "provider_unavailable"],
  ])("classifies a %s on the raw source", async (status, retryable, code) => {
    const failure = await fetchFailure(sourceFailing(() => json({ message: "Gone" }, status)));

    expect(failure).toBeInstanceOf(InboundFetchError);
    expect(failure).toMatchObject({ retryable, code });
  });

  it("retries an empty raw source", async () => {
    expect(await fetchFailure(sourceFailing(() => rfc822(Buffer.alloc(0))))).toMatchObject({
      retryable: true,
      code: "raw_unavailable",
    });
  });

  it("retries a network failure", async () => {
    const receiver = receiverFor(fakeLettermint(() => {
      throw new TypeError("fetch failed");
    }).fetch);

    expect(await fetchFailure(receiver)).toMatchObject({ retryable: true, code: "provider_unreachable" });
  });

  it("times out a hung request and retries it", async () => {
    const hanging: LettermintFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const reason: unknown = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      });

    expect(await fetchFailure(receiverFor(hanging, 5))).toMatchObject({ retryable: true, code: "provider_timeout" });
  });

  it("retries a message record that is not JSON", async () => {
    const failure = await fetchFailure(recordFailing(() => new Response("<html>gateway</html>", { status: 200 })));

    expect(failure).toMatchObject({ retryable: true, code: "malformed_provider_response" });
  });

  it("fails without calling the provider when the client has no team token", async () => {
    const provider = answering();
    const receiver = new LettermintInboundEmailReceiver({
      api: new LettermintApiClient({ projectToken: PROJECT_TOKEN, fetch: provider.fetch }),
      signingSecrets: { current: SIGNING_SECRET, previous: null },
    });

    expect(await fetchFailure(receiver)).toMatchObject({ retryable: false, code: "provider_auth_failed" });
    expect(provider.calls).toHaveLength(0);
  });

  it("never carries a token, provider message or content in the error", async () => {
    const failure = await fetchFailure(recordFailing(() =>
      json({ error: { code: "VALIDATION", message: "alice@customer.test: Subject secret" } }, 422)));
    const rendered = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack ?? ""}`;

    expect(rendered).not.toContain(TEAM_TOKEN);
    expect(rendered).not.toContain("alice@customer.test");
    expect(rendered).not.toContain("Subject secret");
  });
});
