import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type LettermintFetch } from "../../../src/modules/mail/adapters/lettermintApi.js";
import { LettermintApiClient, LettermintEmailDomainProvisioner } from "../../../src/modules/mail/public.js";

const API_FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/lettermint/api/", import.meta.url));
const TEAM_TOKEN = "lm_team_SECRET_9876543210";
const PROJECT_ID = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const DOMAIN = "mail.customer.test";
const DOMAIN_ID = "9d2c6f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ROUTE_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const ROUTE_SLUG = "radioso-inbound-a425581fe0dd6f02";

const BASE = "https://api.lettermint.co/v1";
const DOMAIN_URL = `${BASE}/domains/${DOMAIN_ID}`;
const DOMAIN_WITH_RECORDS_URL = `${DOMAIN_URL}?include=dnsRecords,projects`;
const DOMAIN_PROJECTS_URL = `${DOMAIN_URL}/projects`;
const LIST_DOMAINS_URL = `${BASE}/domains?filter%5Bdomain%5D=mail.customer.test`;
const OWN_PROJECT = { id: PROJECT_ID, name: "Radioso Test" };
const OTHER_PROJECT = { id: "6d7e8f9a-0b1c-4d2e-9f3a-4b5c6d7e8f9a", name: "Radioso Other" };
const ROUTE_SEARCH_URL = `${BASE}/projects/${PROJECT_ID}/routes?filter%5Broute_type%5D=inbound&filter%5Bsearch%5D=${ROUTE_SLUG}`;
const ROUTE_URL = `${BASE}/routes/${ROUTE_ID}`;

type Json = Record<string, unknown>;

const fixtureJson = <T = Json>(name: string): T => JSON.parse(readFileSync(`${API_FIXTURES}${name}`, "utf8")) as T;

type DomainFixture = Json & { dns_records: Json[] };
const domainWithRecords = (statuses: Partial<Record<string, string>> = {}): DomainFixture => {
  const domain = fixtureJson<DomainFixture>("get-domain.dns-records.json");
  domain.dns_records = domain.dns_records.map((record) => ({
    ...record,
    status: statuses[record.purpose as string] ?? record.status,
  }));
  return domain;
};
/** The fixture domain restricted to `projects`; an empty list leaves it unrestricted on the team. */
const domainLimitedTo = (projects: readonly Json[]): DomainFixture => ({ ...domainWithRecords(), projects: [...projects] });
const NOT_THIS_DEPLOYMENTS: readonly [string, readonly Json[]][] = [
  ["unrestricted", []],
  ["for another project", [OTHER_PROJECT]],
];
const inboundRoute = (edit?: (route: Json) => void): Json => {
  const route = fixtureJson("get-route.inbound-custom-domain.json");
  edit?.(route);
  return route;
};
const emptyPage = (): Json => ({ ...fixtureJson<Json>("list-routes.inbound.json"), data: [] });

interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fakeLettermint = (respond: (call: RecordedCall) => Response) => {
  const calls: RecordedCall[] = [];
  const fetch: LettermintFetch = async (url, init) => {
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

const provisionerFor = (fetch: LettermintFetch) =>
  new LettermintEmailDomainProvisioner({
    api: new LettermintApiClient({ teamToken: TEAM_TOKEN, fetch }),
    projectId: PROJECT_ID,
  });

/** A team holding the fixture domain, and the receiving route when `receiving` is given. */
const team = (options: { domain?: Json; receiving?: Json | null; extra?: (call: RecordedCall) => Response | null } = {}) =>
  fakeLettermint((call) => {
    const answered = options.extra?.(call);
    if (answered) return answered;
    if (call.url === DOMAIN_WITH_RECORDS_URL) return json(options.domain ?? domainWithRecords());
    if (call.url === ROUTE_SEARCH_URL) {
      return json(options.receiving ? fixtureJson("list-routes.inbound.json") : emptyPage());
    }
    if (call.url === ROUTE_URL && options.receiving) return json(options.receiving);
    return json({ message: "Not found" }, 404);
  });

const callsOf = (calls: readonly RecordedCall[]) => calls.map(({ method, url }) => `${method} ${url}`);

describe("Lettermint domain provisioner: registration", () => {
  const created = (call: RecordedCall): Response | null =>
    call.method === "POST" && call.url === `${BASE}/domains` ? json(fixtureJson("create-domain.response.json"), 201) : null;
  const restricted = (call: RecordedCall): Response | null =>
    call.method === "PUT" && call.url === DOMAIN_PROJECTS_URL ? json(fixtureJson("update-domain-projects.response.json")) : null;

  it("creates the domain with the team token, restricts it to this deployment's project, then reads its DNS records", async () => {
    const provider = team({ extra: (call) => created(call) ?? restricted(call) });

    const registration = await provisionerFor(provider.fetch).registerSendingDomain(" Mail.Customer.Test. ");

    expect(provider.calls.slice(0, 2)).toEqual([
      {
        method: "POST",
        url: `${BASE}/domains`,
        authorization: `Bearer ${TEAM_TOKEN}`,
        body: { domain: DOMAIN },
      },
      {
        method: "PUT",
        url: DOMAIN_PROJECTS_URL,
        authorization: `Bearer ${TEAM_TOKEN}`,
        body: { project_ids: [PROJECT_ID] },
      },
    ]);
    expect(callsOf(provider.calls)).toEqual([
      `POST ${BASE}/domains`,
      `PUT ${DOMAIN_PROJECTS_URL}`,
      `GET ${DOMAIN_WITH_RECORDS_URL}`,
      `GET ${ROUTE_SEARCH_URL}`,
    ]);
    expect(registration).toEqual({
      ok: true,
      providerDomainId: DOMAIN_ID,
      region: null,
      readiness: {
        sending: "pending",
        receiving: "not_requested",
        records: [
          {
            purpose: "dkim",
            type: "CNAME",
            name: "lm1._domainkey.mail.customer.test",
            value: "lm1.mail-customer-test.dkim.lettermint.co",
            status: "pending",
          },
          {
            purpose: "dkim",
            type: "CNAME",
            name: "lm2._domainkey.mail.customer.test",
            value: "lm2.mail-customer-test.dkim.lettermint.co",
            status: "advisory",
          },
          {
            purpose: "return_path",
            type: "CNAME",
            name: "lm-bounces.mail.customer.test",
            value: "bounces.lmta.net",
            status: "pending",
          },
          { purpose: "dmarc", type: "TXT", name: "_dmarc.mail.customer.test", value: "v=DMARC1; p=none;", status: "advisory" },
        ],
      },
    });
  });

  it.each([
    ["is refused", 422, { message: "Invalid.", errors: { project_ids: ["invalid"] } }, { kind: "rejected", retryable: false }],
    ["is unavailable", 500, { message: "Server error." }, { kind: "unavailable", retryable: true }],
  ])("deletes the domain it just created and rethrows when restricting it %s", async (_label, status, body, expected) => {
    const provider = team({
      extra: (call) => {
        if (call.method === "PUT") return json(body, status);
        return created(call) ?? (call.method === "DELETE" ? json({ message: "Deleted." }) : null);
      },
    });

    const failure = await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN).catch((error: unknown) => error);

    expect(failure).toMatchObject({ ...expected, statusCode: status });
    expect(callsOf(provider.calls)).toEqual([
      `POST ${BASE}/domains`,
      `PUT ${DOMAIN_PROJECTS_URL}`,
      `DELETE ${DOMAIN_URL}`,
    ]);
  });

  it("rethrows the restriction's failure, not the clean-up's, when deleting the new domain fails too", async () => {
    const provider = team({
      extra: (call) => {
        if (call.method === "PUT") return json({ message: "Invalid.", errors: { project_ids: ["invalid"] } }, 422);
        if (call.method === "DELETE") return json({ message: "Server error." }, 500);
        return created(call);
      },
    });

    await expect(provisionerFor(provider.fetch).registerSendingDomain(DOMAIN)).rejects.toMatchObject({
      kind: "rejected",
      statusCode: 422,
    });
  });

  it("reports a name this deployment already holds as already registered", async () => {
    const provider = team({
      extra: (call) => {
        if (call.method === "POST") return json(fixtureJson("create-domain.domain-taken.json"), 422);
        if (call.url.startsWith(`${BASE}/domains?`)) return json(fixtureJson("list-domains.json"));
        return null;
      },
    });

    expect(await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN)).toEqual({
      ok: false,
      refused: "already_registered",
    });
    expect(callsOf(provider.calls).slice(0, 2)).toEqual([`POST ${BASE}/domains`, `GET ${LIST_DOMAINS_URL}`]);
  });

  it.each(NOT_THIS_DEPLOYMENTS)("refuses a taken name the team holds %s as held elsewhere, and changes nothing", async (_label, projects) => {
    const provider = team({
      domain: domainLimitedTo(projects),
      extra: (call) => {
        if (call.method === "POST") return json(fixtureJson("create-domain.domain-taken.json"), 422);
        if (call.url.startsWith(`${BASE}/domains?`)) return json(fixtureJson("list-domains.json"));
        return null;
      },
    });

    expect(await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN)).toEqual({ ok: false, refused: "held_elsewhere" });
    expect(provider.calls.filter((call) => call.method !== "GET").map((call) => call.method)).toEqual(["POST"]);
  });

  it("refuses a taken name this team does not hold as invalid, since another team holds it", async () => {
    const provider = team({
      extra: (call) => {
        if (call.method === "POST") return json(fixtureJson("create-domain.domain-taken.json"), 422);
        if (call.url.startsWith(`${BASE}/domains?`)) return json({ ...fixtureJson<Json>("list-domains.json"), data: [] });
        return null;
      },
    });

    expect(await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN)).toEqual({ ok: false, refused: "invalid_domain" });
  });

  it("refuses a name the provider rejects for another field as invalid without looking it up", async () => {
    const provider = team({
      extra: (call) => (call.method === "POST" ? json({ message: "Invalid.", errors: { name: ["required"] } }, 422) : null),
    });

    expect(await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN)).toEqual({ ok: false, refused: "invalid_domain" });
    expect(provider.calls).toHaveLength(1);
  });

  it.each(["not a domain", "-leading.example", "localhost", "a..b.example", "../etc"])(
    "refuses %j as an invalid domain without calling the provider",
    async (name) => {
      const provider = team();

      expect(await provisionerFor(provider.fetch).registerSendingDomain(name)).toEqual({ ok: false, refused: "invalid_domain" });
      expect(provider.calls).toHaveLength(0);
    },
  );

  it("throws a sanitized, retryable error when the provider fails", async () => {
    const provider = team({
      extra: (call) => (call.method === "POST" ? json({ error: { code: "SERVER_ERROR", message: `boom ${DOMAIN}` } }, 500) : null),
    });

    const failure = await provisionerFor(provider.fetch).registerSendingDomain(DOMAIN).catch((error: unknown) => error);

    const rendered = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(rendered).not.toContain(TEAM_TOKEN);
    expect(rendered).not.toContain("boom");
    expect(rendered).not.toContain(DOMAIN);
    expect(failure).toMatchObject({ retryable: true, kind: "unavailable" });
  });
});

describe("Lettermint domain provisioner: finding a registration by name", () => {
  it("searches the team's domains, matches the name exactly, then reads the match", async () => {
    const list = {
      ...fixtureJson<Json>("list-domains.json"),
      data: [
        { ...fixtureJson<{ data: Json[] }>("list-domains.json").data[0], id: "other", domain: "eu.mail.customer.test" },
        ...fixtureJson<{ data: Json[] }>("list-domains.json").data,
      ],
    };
    const provider = team({ extra: (call) => (call.url.startsWith(`${BASE}/domains?`) ? json(list) : null) });

    const found = await provisionerFor(provider.fetch).findByName(" MAIL.customer.test ");

    expect(callsOf(provider.calls)).toEqual([
      `GET ${LIST_DOMAINS_URL}`,
      `GET ${DOMAIN_WITH_RECORDS_URL}`,
      `GET ${ROUTE_SEARCH_URL}`,
    ]);
    expect(found).toMatchObject({ providerDomainId: DOMAIN_ID, region: null, readiness: { sending: "pending" } });
  });

  it.each(NOT_THIS_DEPLOYMENTS)("finds nothing for a name the team holds %s", async (_label, projects) => {
    const provider = team({
      domain: domainLimitedTo(projects),
      extra: (call) => (call.url.startsWith(`${BASE}/domains?`) ? json(fixtureJson("list-domains.json")) : null),
    });

    expect(await provisionerFor(provider.fetch).findByName(DOMAIN)).toBeNull();
    expect(callsOf(provider.calls)).toEqual([`GET ${LIST_DOMAINS_URL}`, `GET ${DOMAIN_WITH_RECORDS_URL}`]);
  });

  it("finds a domain whose projects include this deployment's among others", async () => {
    const provider = team({
      domain: domainLimitedTo([OTHER_PROJECT, OWN_PROJECT]),
      extra: (call) => (call.url.startsWith(`${BASE}/domains?`) ? json(fixtureJson("list-domains.json")) : null),
    });

    expect(await provisionerFor(provider.fetch).findByName(DOMAIN)).toMatchObject({ providerDomainId: DOMAIN_ID });
  });

  it("follows the cursor until it finds the name", async () => {
    const page = fixtureJson<{ data: Json[] }>("list-domains.json");
    const firstPage = { ...page, data: [{ ...page.data[0], id: "other", domain: "mail.customer.test.example" }], next_cursor: "c2" };
    const provider = team({
      extra: (call) => {
        if (call.url === LIST_DOMAINS_URL) return json(firstPage);
        if (call.url === `${LIST_DOMAINS_URL}&page%5Bcursor%5D=c2`) return json(page);
        return null;
      },
    });

    expect(await provisionerFor(provider.fetch).findByName(DOMAIN)).toMatchObject({ providerDomainId: DOMAIN_ID });
  });

  it("finds nothing when no listed name matches exactly", async () => {
    const page = fixtureJson<{ data: Json[] }>("list-domains.json");
    const provider = team({
      extra: (call) =>
        call.url.startsWith(`${BASE}/domains?`) ? json({ ...page, data: [{ ...page.data[0], domain: `eu.${DOMAIN}` }] }) : null,
    });

    expect(await provisionerFor(provider.fetch).findByName(DOMAIN)).toBeNull();
    expect(provider.calls).toHaveLength(1);
  });

  it("stops on a cursor it has already followed", async () => {
    const page = fixtureJson<{ data: Json[] }>("list-domains.json");
    const provider = team({
      extra: (call) => (call.url.startsWith(`${BASE}/domains?`) ? json({ ...page, data: [], next_cursor: "same" }) : null),
    });

    expect(await provisionerFor(provider.fetch).findByName(DOMAIN)).toBeNull();
    expect(provider.calls).toHaveLength(2);
  });

  it("looks nothing up for a name that is not a domain", async () => {
    const provider = team();

    expect(await provisionerFor(provider.fetch).findByName("../etc")).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("throws a retryable error on a list it cannot read", async () => {
    const provider = team({ extra: (call) => (call.url.startsWith(`${BASE}/domains?`) ? json({ items: [] }) : null) });

    await expect(provisionerFor(provider.fetch).findByName(DOMAIN)).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: true,
    });
  });
});

describe("Lettermint domain provisioner: readiness", () => {
  const readinessOf = (options: Parameters<typeof team>[0]) =>
    provisionerFor(team(options).fetch).readiness({ providerDomainId: DOMAIN_ID, domain: DOMAIN });

  it("is verified once every required record is active", async () => {
    const readiness = await readinessOf({ domain: domainWithRecords({ dkim_primary: "active", return_path: "active" }) });

    expect(readiness.sending).toBe("verified");
    expect(readiness.records.map(({ purpose, status }) => [purpose, status])).toEqual([
      ["dkim", "verified"],
      ["dkim", "advisory"],
      ["return_path", "verified"],
      ["dmarc", "advisory"],
    ]);
  });

  it("fails when a required record failed", async () => {
    const readiness = await readinessOf({ domain: domainWithRecords({ dkim_primary: "active", return_path: "failed" }) });

    expect(readiness.sending).toBe("failed");
    expect(readiness.records.find((record) => record.purpose === "return_path")?.status).toBe("failed");
  });

  it("stays pending while a required record is pending", async () => {
    expect((await readinessOf({ domain: domainWithRecords({ dkim_primary: "active" }) })).sending).toBe("pending");
  });

  it("reports an active recommended record as verified, and a failed one as advisory", async () => {
    const readiness = await readinessOf({ domain: domainWithRecords({ dkim_secondary: "active", dmarc: "failed" }) });

    expect(readiness.records.map(({ purpose, status }) => [purpose, status])).toEqual([
      ["dkim", "pending"],
      ["dkim", "verified"],
      ["return_path", "pending"],
      ["dmarc", "advisory"],
    ]);
  });

  it("stays pending for a domain with no records yet", async () => {
    const readiness = await readinessOf({ domain: { ...domainWithRecords(), dns_records: [] } });

    expect(readiness).toEqual({ sending: "pending", receiving: "not_requested", records: [] });
  });

  it("drops records whose purpose or type it does not know", async () => {
    const domain = domainWithRecords();
    domain.dns_records = [
      { ...domain.dns_records[0], purpose: "bimi" },
      { ...domain.dns_records[0], type: "A" },
      ...domain.dns_records.slice(1),
    ];

    expect((await readinessOf({ domain })).records.map((record) => record.purpose)).toEqual(["dkim", "return_path", "dmarc"]);
  });

  it("adds the receiving MX record of the domain's inbound route, pending until verified", async () => {
    const readiness = await readinessOf({ receiving: inboundRoute() });

    expect(readiness.receiving).toBe("pending");
    expect(readiness.records.at(-1)).toEqual({
      purpose: "receiving_mx",
      type: "MX",
      name: DOMAIN,
      value: "lettermint.mx",
      priority: 10,
      status: "pending",
    });
  });

  it("reports receiving as verified once the route's inbound domain is verified", async () => {
    const readiness = await readinessOf({
      receiving: inboundRoute((route) => {
        route.inbound_domain_verified_at = "2026-10-24T10:00:00.000Z";
        route.inbound_mx_hostname = "mx.lettermint.example";
      }),
    });

    expect(readiness.receiving).toBe("verified");
    expect(readiness.records.at(-1)).toMatchObject({ value: "mx.lettermint.example", status: "verified" });
  });

  it("ignores a route under its slug that receives for another domain", async () => {
    const readiness = await readinessOf({ receiving: inboundRoute((route) => {
      route.inbound_domain = "other.customer.test";
    }) });

    expect(readiness.receiving).toBe("not_requested");
    expect(readiness.records.some((record) => record.purpose === "receiving_mx")).toBe(false);
  });

  it.each(NOT_THIS_DEPLOYMENTS)("reads a recorded domain the team holds %s", async (_label, projects) => {
    const readiness = await readinessOf({ domain: domainLimitedTo(projects), receiving: inboundRoute() });

    expect(readiness).toMatchObject({ sending: "pending", receiving: "pending" });
  });

  it("reads the domain with its records and projects, and looks up the receiving route by its slug", async () => {
    const provider = team({ receiving: inboundRoute() });

    await provisionerFor(provider.fetch).readiness({ providerDomainId: DOMAIN_ID, domain: DOMAIN });

    expect(callsOf(provider.calls)).toEqual([
      `GET ${DOMAIN_WITH_RECORDS_URL}`,
      `GET ${ROUTE_SEARCH_URL}`,
      `GET ${ROUTE_URL}`,
    ]);
  });
});

describe("Lettermint domain provisioner: receiving", () => {
  const createdRoute = () => json({ data: inboundRoute(), message: "Route created." }, 201);

  it("creates one inbound route for the domain in the configured project", async () => {
    const provider = team({
      extra: (call) => (call.method === "POST" ? createdRoute() : null),
    });

    const readiness = await provisionerFor(provider.fetch).enableReceiving(DOMAIN_ID);

    const creates = provider.calls.filter((call) => call.method === "POST");
    expect(creates).toEqual([
      {
        method: "POST",
        url: `${BASE}/projects/${PROJECT_ID}/routes`,
        authorization: `Bearer ${TEAM_TOKEN}`,
        body: {
          name: DOMAIN,
          slug: ROUTE_SLUG,
          route_type: "inbound",
          inbound_domain: DOMAIN,
          inbound_spam_threshold: 5,
          attachment_delivery: "url",
        },
      },
    ]);
    expect(readiness.receiving).toBe("pending");
    expect(readiness.records.at(-1)).toMatchObject({ purpose: "receiving_mx", name: DOMAIN, value: "lettermint.mx", priority: 10 });
  });

  it("creates no second route when the domain already has one", async () => {
    const provider = team({ receiving: inboundRoute() });

    const readiness = await provisionerFor(provider.fetch).enableReceiving(DOMAIN_ID);

    expect(provider.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(readiness.receiving).toBe("pending");
  });

  it.each(NOT_THIS_DEPLOYMENTS)("creates no route for a domain held %s, whose mail is not this deployment's", async (_label, projects) => {
    const provider = team({ domain: domainLimitedTo(projects), extra: (call) => (call.method === "POST" ? createdRoute() : null) });

    await expect(provisionerFor(provider.fetch).enableReceiving(DOMAIN_ID)).rejects.toMatchObject({ kind: "not_found" });
    expect(provider.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("adopts the route a concurrent request created when its own create is refused", async () => {
    let created = false;
    const provider = fakeLettermint((call) => {
      if (call.url === DOMAIN_WITH_RECORDS_URL) return json(domainWithRecords());
      if (call.method === "POST") {
        created = true;
        return json({ message: "The slug has already been taken.", errors: { slug: ["taken"] } }, 422);
      }
      if (call.url === ROUTE_SEARCH_URL) return json(created ? fixtureJson("list-routes.inbound.json") : emptyPage());
      if (call.url === ROUTE_URL) return json(inboundRoute());
      return json({ message: "Not found" }, 404);
    });

    expect((await provisionerFor(provider.fetch).enableReceiving(DOMAIN_ID)).receiving).toBe("pending");
  });

  it("rethrows a refused create when no route exists afterwards", async () => {
    const provider = team({
      extra: (call) => (call.method === "POST" ? json({ message: "Inbound routes need a paid plan." }, 403) : null),
    });

    await expect(provisionerFor(provider.fetch).enableReceiving(DOMAIN_ID)).rejects.toMatchObject({ kind: "rejected", retryable: false });
  });
});

describe("Lettermint domain provisioner: verification and removal", () => {
  it("asks the provider to verify the DNS records and the receiving route's MX", async () => {
    const provider = team({
      receiving: inboundRoute(),
      extra: (call) => (call.method === "POST" ? json({ message: "Verified.", recommended_failed_records: [] }) : null),
    });

    await provisionerFor(provider.fetch).requestVerification(DOMAIN_ID);

    expect(callsOf(provider.calls).filter((call) => call.startsWith("POST"))).toEqual([
      `POST ${DOMAIN_URL}/dns-records/verify`,
      `POST ${ROUTE_URL}/verify-inbound-domain`,
    ]);
  });

  it("treats records that do not verify yet as a completed request", async () => {
    const provider = team({
      receiving: inboundRoute(),
      extra: (call) => {
        if (call.url === `${DOMAIN_URL}/dns-records/verify`) return json(fixtureJson("verify-dns-records.failed.json"), 422);
        if (call.url === `${ROUTE_URL}/verify-inbound-domain`) return json(fixtureJson("verify-inbound-domain.failed.json"), 422);
        return null;
      },
    });

    await expect(provisionerFor(provider.fetch).requestVerification(DOMAIN_ID)).resolves.toBeUndefined();
  });

  it("verifies only the DNS records when the domain does not receive", async () => {
    const provider = team({ extra: (call) => (call.method === "POST" ? json({ message: "Verified." }) : null) });

    await provisionerFor(provider.fetch).requestVerification(DOMAIN_ID);

    expect(callsOf(provider.calls).filter((call) => call.startsWith("POST"))).toEqual([`POST ${DOMAIN_URL}/dns-records/verify`]);
  });

  it("removes the receiving route, then the domain", async () => {
    const provider = team({
      receiving: inboundRoute(),
      extra: (call) => (call.method === "DELETE" ? json({ message: "Deleted." }) : null),
    });

    await provisionerFor(provider.fetch).remove(DOMAIN_ID);

    expect(callsOf(provider.calls).filter((call) => call.startsWith("DELETE"))).toEqual([`DELETE ${ROUTE_URL}`, `DELETE ${DOMAIN_URL}`]);
  });

  it.each(NOT_THIS_DEPLOYMENTS)("deletes neither route nor domain the team holds %s", async (_label, projects) => {
    const provider = team({
      domain: domainLimitedTo(projects),
      receiving: inboundRoute(),
      extra: (call) => (call.method === "DELETE" ? json({ message: "Deleted." }) : null),
    });

    await expect(provisionerFor(provider.fetch).remove(DOMAIN_ID)).resolves.toBeUndefined();
    expect(callsOf(provider.calls)).toEqual([`GET ${DOMAIN_WITH_RECORDS_URL}`]);
  });

  it("treats a route or domain the provider no longer has as removed", async () => {
    const provider = team({
      receiving: inboundRoute(),
      extra: (call) => (call.method === "DELETE" ? json({ message: "Not found" }, 404) : null),
    });

    await expect(provisionerFor(provider.fetch).remove(DOMAIN_ID)).resolves.toBeUndefined();
  });

  it("treats removing a domain that is already gone as done", async () => {
    const provider = fakeLettermint(() => json({ message: "Not found" }, 404));

    await expect(provisionerFor(provider.fetch).remove(DOMAIN_ID)).resolves.toBeUndefined();
    expect(callsOf(provider.calls)).toEqual([`GET ${DOMAIN_WITH_RECORDS_URL}`]);
  });
});
