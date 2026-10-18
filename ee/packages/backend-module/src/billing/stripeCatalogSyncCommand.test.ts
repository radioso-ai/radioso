import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  StripeAccountSummary,
  StripeCatalogAdmin,
  StripeCreatedWebhookEndpoint,
  StripePortalConfigurationState,
  StripePortalFeatures,
  StripePriceInput,
  StripePriceState,
  StripeProductInput,
  StripeProductPatch,
  StripeProductState,
  StripeTaxDefaultsInput,
  StripeTaxSettingsState,
  StripeWebhookEndpointInput,
  StripeWebhookEndpointState,
} from "./stripeCatalogAdmin.js";
import { runStripeCatalogSyncCommand } from "./stripeCatalogSyncCommand.js";

// Built at runtime: a literal key-shaped string trips secret scanners on push.
const TEST_KEY = `sk_test_${"0".repeat(24)}`;
const LIVE_KEY = `rk_live_${"0".repeat(24)}`;
const WEBHOOK_URL = "https://app.example.com/api/v1/ee/billing/webhook";

interface StoredPrice extends Omit<StripePriceState, "lookupKey"> {
  lookupKey: string | null;
}

/** In-memory Stripe account with the semantics the sync relies on: caller-chosen product ids,
 *  unique lookup keys that only move with `transferLookupKey`, and a secret shown once. */
class FakeStripeCatalogAdmin implements StripeCatalogAdmin {
  readonly apiVersion = "2026-08-26.dahlia";
  readonly writes: string[] = [];
  readonly products = new Map<string, StripeProductState>();
  readonly prices: StoredPrice[] = [];
  readonly webhooks: StripeWebhookEndpointState[] = [];
  readonly portals: StripePortalConfigurationState[] = [];
  tax: StripeTaxSettingsState = {
    status: "pending",
    missingFields: ["head_office"],
    defaultTaxBehavior: null,
    defaultTaxCode: null,
  };
  activeRegistrations = 0;
  createdPortalIsDefault = true;
  private nextId = 1;

  async retrieveAccount(): Promise<StripeAccountSummary> {
    return { id: "acct_fake", name: "Radioso Sandbox" };
  }

  async retrieveProduct(id: string): Promise<StripeProductState | null> {
    return this.products.get(id) ?? null;
  }

  async createProduct(input: StripeProductInput): Promise<void> {
    if (this.products.has(input.id)) {
      throw new Error(`product ${input.id} already exists`);
    }
    this.writes.push(`create_product ${input.id}`);
    this.products.set(input.id, { ...input, active: true, metadata: { ...input.metadata } });
  }

  async updateProduct(id: string, patch: StripeProductPatch): Promise<void> {
    const product = this.products.get(id)!;
    this.writes.push(`update_product ${id}`);
    const metadata: Record<string, string> = { ...product.metadata };
    for (const [key, value] of Object.entries(patch.metadata ?? {})) {
      if (value === "") {
        delete metadata[key];
      } else {
        metadata[key] = value;
      }
    }
    this.products.set(id, {
      ...product,
      name: patch.name ?? product.name,
      active: patch.active ?? product.active,
      taxCode: patch.taxCode ?? product.taxCode,
      metadata,
    });
  }

  async findPriceByLookupKey(lookupKey: string): Promise<StripePriceState | null> {
    const holders = this.prices.filter((price) => price.lookupKey === lookupKey);
    const holder = holders.find((price) => price.active) ?? holders[0];
    return holder ? { ...holder, lookupKey } : null;
  }

  async createPrice(input: StripePriceInput): Promise<{ id: string }> {
    const holder = this.prices.find((price) => price.lookupKey === input.lookupKey);
    if (holder && !input.transferLookupKey) {
      throw new Error(`A price (${holder.id}) already uses that lookup key.`);
    }
    if (holder) {
      holder.lookupKey = null;
    }
    const id = `price_${this.nextId++}`;
    this.writes.push(`create_price ${input.lookupKey}`);
    this.prices.push({
      id,
      lookupKey: input.lookupKey,
      active: true,
      productId: input.productId,
      unitAmount: input.unitAmount,
      currency: input.currency,
      recurring: input.recurringInterval ? { interval: input.recurringInterval, intervalCount: 1 } : null,
      taxBehavior: input.taxBehavior,
    });
    return { id };
  }

  async listWebhookEndpoints(): Promise<StripeWebhookEndpointState[]> {
    return this.webhooks.map((endpoint) => ({ ...endpoint }));
  }

  lastCreateWebhookEndpointApiVersion: string | null = null;

  async createWebhookEndpoint(input: StripeWebhookEndpointInput): Promise<StripeCreatedWebhookEndpoint> {
    const id = `we_${this.nextId++}`;
    this.writes.push(`create_webhook_endpoint ${input.url}`);
    this.lastCreateWebhookEndpointApiVersion = input.apiVersion;
    this.webhooks.push({ id, url: input.url, enabledEvents: [...input.enabledEvents], apiVersion: this.apiVersion, enabled: true });
    return { id, secret: `whsec_fakeSigningSecret${id}` };
  }

  async updateWebhookEndpoint(id: string, input: { enabledEvents: readonly string[] }): Promise<void> {
    this.writes.push(`update_webhook_endpoint ${id}`);
    const endpoint = this.webhooks.find((candidate) => candidate.id === id)!;
    endpoint.enabledEvents = [...input.enabledEvents];
    endpoint.enabled = true;
  }

  async findPortalConfiguration(): Promise<StripePortalConfigurationState | null> {
    return this.portals.find((portal) => portal.isDefault) ?? this.portals[0] ?? null;
  }

  async createPortalConfiguration(features: StripePortalFeatures): Promise<StripePortalConfigurationState> {
    const created = { id: `bpc_${this.nextId++}`, isDefault: this.createdPortalIsDefault, features };
    this.writes.push(`create_portal_configuration ${created.id}`);
    this.portals.push(created);
    return created;
  }

  async updatePortalConfiguration(id: string, features: StripePortalFeatures): Promise<void> {
    this.writes.push(`update_portal_configuration ${id}`);
    const portal = this.portals.find((candidate) => candidate.id === id)!;
    portal.features = features;
  }

  async retrieveTaxSettings(): Promise<StripeTaxSettingsState> {
    return this.tax;
  }

  async updateTaxDefaults(input: StripeTaxDefaultsInput): Promise<void> {
    this.writes.push("update_tax_defaults");
    this.tax = { ...this.tax, defaultTaxBehavior: input.taxBehavior, defaultTaxCode: input.taxCode };
  }

  async countActiveTaxRegistrations(): Promise<number> {
    return this.activeRegistrations;
  }
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

const run = async (
  admin: FakeStripeCatalogAdmin,
  argv: string[],
  env: Record<string, string | undefined> = { STRIPE_SECRET_KEY: TEST_KEY },
  cwd: string = process.cwd(),
): Promise<RunResult & { adminCreated: boolean }> => {
  const out: string[] = [];
  const err: string[] = [];
  let adminCreated = false;
  const code = await runStripeCatalogSyncCommand({
    argv,
    env,
    cwd,
    createAdmin: () => {
      adminCreated = true;
      return admin;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), adminCreated };
};

describe("runStripeCatalogSyncCommand", () => {
  let admin: FakeStripeCatalogAdmin;
  let dir: string;

  beforeEach(async () => {
    admin = new FakeStripeCatalogAdmin();
    dir = await mkdtemp(join(tmpdir(), "stripe-catalog-sync-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dry-runs by default: prints the mode, the account, and the plan, and changes nothing", async () => {
    const result = await run(admin, []);

    expect(result.code).toBe(0);
    expect(result.out).toContain("Stripe TEST mode");
    expect(result.out).toContain("acct_fake");
    expect(result.out).toContain("radioso_plan_satellite");
    expect(result.out).toContain("satellite_month");
    expect(result.out).toMatch(/dry run/i);
    expect(admin.writes).toEqual([]);
  });

  it("applies the plan, and a second apply finds nothing left to change", async () => {
    const first = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", join(dir, "whsec")]);
    expect(first.code).toBe(0);
    expect(admin.writes).toContain("create_product radioso_plan_satellite");
    expect(admin.writes).toContain("create_price satellite_month");
    expect(admin.writes).toContain("update_tax_defaults");
    expect(admin.writes.some((write) => write.startsWith("create_portal_configuration"))).toBe(true);
    expect(admin.writes).toContain(`create_webhook_endpoint ${WEBHOOK_URL}`);
    expect(admin.portals[0]?.features.subscriptionUpdate.products).toHaveLength(2);

    const writesAfterFirst = admin.writes.length;
    const second = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", join(dir, "whsec-2")]);

    expect(second.code).toBe(0);
    expect(admin.writes).toHaveLength(writesAfterFirst);
    expect(second.out).toMatch(/already matches/i);
  });

  it("re-points the portal at a new price after a price change and keeps the old price active", async () => {
    await run(admin, ["--apply"]);
    const old = admin.prices.find((price) => price.lookupKey === "satellite_month")!;
    old.unitAmount = 100;

    const result = await run(admin, ["--apply"]);

    expect(result.code).toBe(0);
    const current = admin.prices.find((price) => price.lookupKey === "satellite_month")!;
    expect(current.id).not.toBe(old.id);
    expect(old.active).toBe(true);
    const offered = admin.portals[0].features.subscriptionUpdate.products.flatMap((product) => product.priceIds);
    expect(offered).toContain(current.id);
    expect(offered).not.toContain(old.id);
  });

  it("refuses to apply to a live account without --live, before talking to Stripe", async () => {
    const result = await run(admin, ["--apply"], { STRIPE_SECRET_KEY: LIVE_KEY });

    expect(result.code).toBe(1);
    expect(result.err).toContain("--live");
    expect(result.adminCreated).toBe(false);
    expect(admin.writes).toEqual([]);
  });

  it("dry-runs a live account without --live and applies with --apply --live", async () => {
    const dry = await run(admin, [], { STRIPE_SECRET_KEY: LIVE_KEY });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Stripe LIVE mode");
    expect(admin.writes).toEqual([]);

    const applied = await run(admin, ["--apply", "--live"], { STRIPE_SECRET_KEY: LIVE_KEY });
    expect(applied.code).toBe(0);
    expect(admin.writes.length).toBeGreaterThan(0);
  });

  it("rejects a missing or unrecognized key", async () => {
    expect((await run(admin, [], {})).code).toBe(1);
    const wrongKind = await run(admin, [], { STRIPE_SECRET_KEY: "pk_test_publishable" });
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.adminCreated).toBe(false);
  });

  it("refuses --live with a test-mode key, before talking to Stripe", async () => {
    const result = await run(admin, ["--apply", "--live"], { STRIPE_SECRET_KEY: TEST_KEY });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/--live/);
    expect(result.err).toMatch(/test/i);
    expect(result.adminCreated).toBe(false);
    expect(admin.writes).toEqual([]);
  });

  it("rejects a non-https --webhook-url", async () => {
    const result = await run(admin, ["--webhook-url", "http://app.example.com/api/v1/ee/billing/webhook"]);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/https/);
    expect(result.adminCreated).toBe(false);
  });

  it("resolves a relative --webhook-secret-file against the given base directory, not the process cwd", async () => {
    const result = await run(
      admin,
      ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", "whsec"],
      { STRIPE_SECRET_KEY: TEST_KEY },
      dir,
    );

    expect(result.code).toBe(0);
    const secret = await readFile(join(dir, "whsec"), "utf8");
    expect(secret).toMatch(/^whsec_/);
  });

  it("creates the webhook endpoint pinned to the adapter's API version", async () => {
    await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL]);

    expect(admin.lastCreateWebhookEndpointApiVersion).toBe(admin.apiVersion);
  });

  it("writes a new endpoint's signing secret to a 0600 file and never prints it or the API key", async () => {
    const secretFile = join(dir, "whsec");

    const result = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", secretFile]);

    expect(result.code).toBe(0);
    const secret = await readFile(secretFile, "utf8");
    expect(secret).toMatch(/^whsec_/);
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    for (const stream of [result.out, result.err]) {
      expect(stream).not.toContain(secret);
      expect(stream).not.toContain(TEST_KEY);
    }
    expect(result.out).toContain(secretFile);
  });

  it("refuses to overwrite an existing secret file, before changing anything", async () => {
    const secretFile = join(dir, "whsec");
    await writeFile(secretFile, "keep me");

    const result = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", secretFile]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(secretFile);
    expect(admin.writes).toEqual([]);
    expect(await readFile(secretFile, "utf8")).toBe("keep me");
  });

  it("refuses a secret file whose directory does not exist, before changing anything", async () => {
    const secretFile = join(dir, "missing-subdir", "whsec");

    const result = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", secretFile]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(secretFile);
    expect(admin.writes).toEqual([]);
  });

  it("prints the secret and exits non-zero when writing it still fails after the endpoint is created", async () => {
    const notADirectory = join(dir, "not-a-directory");
    await writeFile(notADirectory, "a file, not a directory");
    const secretFile = join(notADirectory, "whsec");

    const result = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL, "--webhook-secret-file", secretFile]);

    expect(result.code).toBe(1);
    expect(admin.writes).toContain(`create_webhook_endpoint ${WEBHOOK_URL}`);
    const secret = `whsec_fakeSigningSecret${admin.webhooks[0].id}`;
    expect(result.out).toContain(secret);
    expect(result.out).toMatch(/could not write/i);
    expect(result.out).toMatch(/store this secret now/i);
  });

  it("prints a new endpoint's signing secret once when no secret file is given", async () => {
    const result = await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL]);

    expect(result.code).toBe(0);
    const secret = `whsec_fakeSigningSecret${admin.webhooks[0].id}`;
    expect(result.out.split(secret)).toHaveLength(2);
    expect(result.out).toMatch(/store this now/i);
    expect(result.out).not.toContain(TEST_KEY);
  });

  it("says an existing endpoint's secret cannot be read back", async () => {
    await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL]);

    const result = await run(admin, ["--webhook-url", WEBHOOK_URL]);

    expect(result.out).toMatch(/signing secret/i);
    expect(result.out).not.toContain("whsec_");
  });

  it("rejects --webhook-secret-file without --webhook-url, and unknown flags", async () => {
    expect((await run(admin, ["--webhook-secret-file", join(dir, "whsec")])).code).toBe(1);
    expect((await run(admin, ["--aply"])).code).toBe(1);
    expect(admin.writes).toEqual([]);
  });

  it("writes plan ids under STRIPE_PLAN_METADATA_KEY when it is set", async () => {
    await run(admin, ["--apply"], { STRIPE_SECRET_KEY: TEST_KEY, STRIPE_PLAN_METADATA_KEY: "radioso_plan" });

    expect(admin.products.get("radioso_plan_satellite")?.metadata).toEqual({ radioso_plan: "satellite" });
  });

  it("warns when the portal configuration it created is not the default", async () => {
    admin.createdPortalIsDefault = false;

    const created = await run(admin, ["--apply"]);
    expect(created.out).toMatch(/not the default/i);

    const rerun = await run(admin, ["--apply"]);
    expect(admin.portals).toHaveLength(1);
    expect(rerun.out).toMatch(/not the default/i);
  });

  it("warns that Checkout fails until Stripe Tax has a head office address", async () => {
    const result = await run(admin, []);

    expect(result.out).toMatch(/head office/i);
    expect(result.out).toContain("0 active registrations");
  });

  it("prints which events it is adding, not the whole list, when it updates an existing endpoint", async () => {
    await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL]);
    admin.webhooks[0].enabledEvents = ["invoice.paid"];

    const result = await run(admin, ["--webhook-url", WEBHOOK_URL]);

    expect(result.out).toMatch(
      /add checkout\.session\.completed, customer\.subscription\.updated, customer\.subscription\.deleted, invoice\.payment_failed/,
    );
  });

  it("notices, without advising deletion, when an endpoint follows the account's default API version", async () => {
    await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL]);
    admin.webhooks[0].apiVersion = null;

    const result = await run(admin, ["--webhook-url", WEBHOOK_URL]);

    expect(result.out).toMatch(/Note: webhook endpoint .* account's default API version/i);
    expect(result.out).not.toMatch(/delete the endpoint/i);
  });

  it("warns, advising deletion, when an endpoint uses a specific, different API version", async () => {
    await run(admin, ["--apply", "--webhook-url", WEBHOOK_URL]);
    admin.webhooks[0].apiVersion = "2024-06-20";

    const result = await run(admin, ["--webhook-url", WEBHOOK_URL]);

    expect(result.out).toMatch(/Warning: webhook endpoint .* API version/i);
    expect(result.out).toMatch(/delete the endpoint/i);
  });

  it("reports a Stripe failure with exit code 1 and keeps the API key out of the message", async () => {
    admin.retrieveProduct = async () => {
      throw new Error(`Invalid API Key provided: ${TEST_KEY}`);
    };

    const result = await run(admin, []);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Invalid API Key provided");
    expect(result.err).not.toContain(TEST_KEY);
  });
});
