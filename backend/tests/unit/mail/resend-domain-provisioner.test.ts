import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ResendApiClient, type ResendFetch } from "../../../src/modules/mail/adapters/resendApi.js";
import {
  ResendEmailDomainProvisioner,
  type TxtResolver,
} from "../../../src/modules/mail/adapters/resendDomainProvisioner.js";

const RESEND_FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/resend/", import.meta.url));
const API_KEY = "re_test_SECRETKEY_0123456789";
const DOMAIN = "s0-email-channel.radioso.ai";
const DOMAIN_ID = "9c539a5d-e048-4fb5-8490-d2a02dbe2850";

type DomainRecord = Record<string, unknown> & { records: Record<string, unknown>[] };

const fixtureJson = <T = Record<string, unknown>>(path: string): T =>
  JSON.parse(readFileSync(`${RESEND_FIXTURES}${path}`, "utf8")) as T;

/** The recorded create response, exactly as Resend returned it (receiving only, sending disabled). */
const recordedDomain = (): DomainRecord => fixtureJson<DomainRecord>("api/create-domain.receiving-eu.json");

/**
 * The recorded domain with sending enabled. The two SPF records follow the recorded record shape
 * (`record`, `name`, `type`, `value`, `ttl`, `status`, `priority` on MX only) on Resend's `send.`
 * subdomain.
 */
const sendingDomain = (statuses: { dkim?: string; spf?: string; receiving?: string; domain?: string } = {}) => {
  const domain = recordedDomain();
  domain.capabilities = { sending: "enabled", receiving: "enabled" };
  domain.status = statuses.domain ?? "not_started";
  const [dkim, receiving] = domain.records as [Record<string, unknown>, Record<string, unknown>];
  dkim.status = statuses.dkim ?? "not_started";
  receiving.status = statuses.receiving ?? "not_started";
  domain.records = [
    dkim,
    {
      record: "SPF",
      name: "send.s0-email-channel",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      type: "MX",
      priority: 10,
      status: statuses.spf ?? "not_started",
      ttl: "Auto",
    },
    {
      record: "SPF",
      name: "send.s0-email-channel",
      value: '"v=spf1 include:amazonses.com ~all"',
      type: "TXT",
      status: statuses.spf ?? "not_started",
      ttl: "Auto",
    },
    receiving,
  ];
  return domain;
};

interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeResend = (respond: (call: RecordedCall) => Response) => {
  const calls: RecordedCall[] = [];
  const fetch: ResendFetch = async (url, init) => {
    const call: RecordedCall = {
      method: init.method ?? "GET",
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
};

const noDmarc: TxtResolver = async () => {
  throw Object.assign(new Error("queryTxt ENODATA"), { code: "ENODATA" });
};

const provisionerFor = (fetch: ResendFetch, resolveTxt: TxtResolver = noDmarc) =>
  new ResendEmailDomainProvisioner({
    api: new ResendApiClient({ apiKey: API_KEY, fetch }),
    region: "eu-west-1",
    resolveTxt,
  });

const readinessOf = async (domain: Record<string, unknown>, resolveTxt?: TxtResolver) =>
  provisionerFor(fakeResend(() => json(domain)).fetch, resolveTxt).readiness({
    providerDomainId: DOMAIN_ID,
    domain: DOMAIN,
  });

describe("Resend domain provisioner: registration", () => {
  it("creates the domain in the configured region with tracking disabled and receiving off", async () => {
    const provider = fakeResend(() => json(sendingDomain()));

    await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN);

    expect(provider.calls[0]).toEqual({
      method: "POST",
      url: "https://api.resend.com/domains",
      authorization: `Bearer ${API_KEY}`,
      body: {
        name: DOMAIN,
        region: "eu-west-1",
        open_tracking: false,
        click_tracking: false,
        capabilities: { sending: "enabled", receiving: "disabled" },
      },
    });
  });

  it("maps the recorded create response's records and capabilities", async () => {
    const registration = await provisionerFor(fakeResend(() => json(recordedDomain())).fetch).registerSendingDomain(
      DOMAIN,
    );

    expect(registration).toEqual({
      ok: true,
      providerDomainId: DOMAIN_ID,
      region: "eu-west-1",
      readiness: {
        sending: "pending",
        receiving: "pending",
        records: [
          {
            purpose: "dkim",
            type: "TXT",
            name: "resend._domainkey.s0-email-channel",
            value: expect.stringMatching(/^p=MIGfMA0/) as unknown,
            status: "pending",
          },
          {
            purpose: "receiving_mx",
            type: "MX",
            name: "s0-email-channel",
            value: "inbound-smtp.eu-west-1.amazonaws.com",
            priority: 10,
            status: "pending",
          },
          {
            purpose: "dmarc",
            type: "TXT",
            name: "_dmarc.s0-email-channel",
            value: "v=DMARC1; p=none;",
            status: "advisory",
          },
        ],
      },
    });
  });

  it("maps Resend's SPF records to spf and return_path", async () => {
    const readiness = await readinessOf(sendingDomain());

    expect(readiness.records.map(({ purpose, type, name }) => ({ purpose, type, name }))).toEqual([
      { purpose: "dkim", type: "TXT", name: "resend._domainkey.s0-email-channel" },
      { purpose: "return_path", type: "MX", name: "send.s0-email-channel" },
      { purpose: "spf", type: "TXT", name: "send.s0-email-channel" },
      { purpose: "receiving_mx", type: "MX", name: "s0-email-channel" },
      { purpose: "dmarc", type: "TXT", name: "_dmarc.s0-email-channel" },
    ]);
  });

  it("refuses a domain already registered at the provider as claimed elsewhere", async () => {
    const duplicate = fixtureJson("api/create-domain.duplicate-same-account.json");

    const registration = await provisionerFor(fakeResend(() => json(duplicate, 403)).fetch).registerSendingDomain(
      "radioso.ai",
    );

    expect(registration).toEqual({ ok: false, refused: "claimed_elsewhere" });
  });

  it.each(["not a domain", "-leading.example", "localhost", "a..b.example", "../etc", `${"a".repeat(64)}.example`])(
    "refuses %j as an invalid domain without calling the provider",
    async (name) => {
      const provider = fakeResend(() => json(sendingDomain()));

      await expect(provisionerFor(provider.fetch).registerSendingDomain(name)).resolves.toEqual({
        ok: false,
        refused: "invalid_domain",
      });
      expect(provider.calls).toHaveLength(0);
    },
  );

  it("refuses a domain the provider rejects as invalid", async () => {
    const provider = fakeResend(() => json({ statusCode: 422, name: "validation_error", message: "Invalid" }, 422));

    await expect(provisionerFor(provider.fetch).registerSendingDomain("customer.test")).resolves.toEqual({
      ok: false,
      refused: "invalid_domain",
    });
  });

  it("throws a sanitized error when the provider fails", async () => {
    const provider = fakeResend(() =>
      json({ statusCode: 500, name: "internal_server_error", message: `boom ${DOMAIN} ${API_KEY}` }, 500),
    );

    const failure = await provisionerFor(provider.fetch)
      .registerSendingDomain(DOMAIN)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const rendered = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(rendered).not.toContain(API_KEY);
    expect(rendered).not.toContain("boom");
    expect(failure).toMatchObject({ retryable: true });
  });
});

describe("Resend domain provisioner: readiness", () => {
  it.each([
    ["verified", "verified"],
    ["failed", "failed"],
    ["pending", "pending"],
    ["not_started", "pending"],
    ["temporary_failure", "pending"],
  ])("maps a %s domain to %s for both capabilities", async (status, expected) => {
    const readiness = await readinessOf(sendingDomain({ domain: status }));

    expect(readiness.sending).toBe(expected);
    expect(readiness.receiving).toBe(expected);
  });

  it("reads each capability from its records when the domain is partially_verified", async () => {
    const readiness = await readinessOf(
      sendingDomain({ domain: "partially_verified", dkim: "verified", spf: "verified", receiving: "pending" }),
    );

    expect(readiness.sending).toBe("verified");
    expect(readiness.receiving).toBe("pending");
  });

  it("reads each capability from its records when the domain is partially_failed", async () => {
    const readiness = await readinessOf(
      sendingDomain({ domain: "partially_failed", dkim: "verified", spf: "failed", receiving: "verified" }),
    );

    expect(readiness.sending).toBe("failed");
    expect(readiness.receiving).toBe("verified");
  });

  it("maps per-record statuses", async () => {
    const readiness = await readinessOf(
      sendingDomain({ domain: "partially_failed", dkim: "verified", spf: "temporary_failure", receiving: "failed" }),
    );

    expect(readiness.records.map(({ purpose, status }) => [purpose, status])).toEqual([
      ["dkim", "verified"],
      ["return_path", "pending"],
      ["spf", "pending"],
      ["receiving_mx", "failed"],
      ["dmarc", "advisory"],
    ]);
  });

  it("reports receiving as not requested when the capability is disabled", async () => {
    const domain = sendingDomain({ domain: "verified" });
    domain.capabilities = { sending: "enabled", receiving: "disabled" };
    domain.records = domain.records.filter((record) => record.record !== "Receiving");

    const readiness = await readinessOf(domain);

    expect(readiness.receiving).toBe("not_requested");
    expect(readiness.records.some((record) => record.purpose === "receiving_mx")).toBe(false);
  });

  it("reads the domain by id", async () => {
    const provider = fakeResend(() => json(sendingDomain()));

    await provisionerFor(provider.fetch).readiness({ providerDomainId: DOMAIN_ID, domain: DOMAIN });

    expect(provider.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET https://api.resend.com/domains/${DOMAIN_ID}`,
    ]);
  });
});

describe("Resend domain provisioner: advisory DMARC", () => {
  it("looks up the DMARC TXT for the domain through the injected resolver", async () => {
    const lookups: string[] = [];
    const resolver: TxtResolver = async (hostname) => {
      lookups.push(hostname);
      return [["v=DMARC1; p=reject; rua=mailto:dmarc@radioso.ai"]];
    };

    const readiness = await readinessOf(sendingDomain(), resolver);

    expect(lookups).toEqual([`_dmarc.${DOMAIN}`]);
    expect(readiness.records.find((record) => record.purpose === "dmarc")).toMatchObject({ status: "verified" });
  });

  it("joins a DMARC record split across TXT strings", async () => {
    const readiness = await readinessOf(sendingDomain(), async () => [["v=DMARC1;", " p=none;"]]);

    expect(readiness.records.find((record) => record.purpose === "dmarc")).toMatchObject({ status: "verified" });
  });

  it.each([
    ["no record", noDmarc],
    ["an unrelated TXT record", (async () => [["google-site-verification=abc"]]) satisfies TxtResolver],
    [
      "a resolver timeout",
      (async () => {
        throw Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" });
      }) satisfies TxtResolver,
    ],
  ])("keeps the recommendation advisory on %s", async (_label, resolver) => {
    const readiness = await readinessOf(sendingDomain(), resolver);

    expect(readiness.records.find((record) => record.purpose === "dmarc")).toMatchObject({ status: "advisory" });
  });

  it("never gates sending readiness on DMARC", async () => {
    const readiness = await readinessOf(sendingDomain({ domain: "verified" }), noDmarc);

    expect(readiness.sending).toBe("verified");
  });
});

describe("Resend domain provisioner: lifecycle", () => {
  it("enables receiving, then reads the domain back", async () => {
    const provider = fakeResend((call) =>
      call.method === "PATCH" ? json({ object: "domain", id: DOMAIN_ID }) : json(sendingDomain()),
    );

    const readiness = await provisionerFor(provider.fetch).enableReceiving(DOMAIN_ID);

    expect(provider.calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: "PATCH",
        url: `https://api.resend.com/domains/${DOMAIN_ID}`,
        body: { capabilities: { sending: "enabled", receiving: "enabled" } },
      },
      { method: "GET", url: `https://api.resend.com/domains/${DOMAIN_ID}`, body: null },
    ]);
    expect(readiness.receiving).toBe("pending");
  });

  it("asks the provider to verify", async () => {
    const provider = fakeResend(() => json({ object: "domain", id: DOMAIN_ID }));

    await provisionerFor(provider.fetch).requestVerification(DOMAIN_ID);

    expect(provider.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST https://api.resend.com/domains/${DOMAIN_ID}/verify`,
    ]);
  });

  it("removes the domain", async () => {
    const provider = fakeResend(() => json({ object: "domain", id: DOMAIN_ID, deleted: true }));

    await provisionerFor(provider.fetch).remove(DOMAIN_ID);

    expect(provider.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `DELETE https://api.resend.com/domains/${DOMAIN_ID}`,
    ]);
  });

  it("treats removing a domain the provider no longer has as done", async () => {
    const provider = fakeResend(() => json({ statusCode: 404, name: "not_found", message: "Domain not found" }, 404));

    await expect(provisionerFor(provider.fetch).remove(DOMAIN_ID)).resolves.toBeUndefined();
  });
});
