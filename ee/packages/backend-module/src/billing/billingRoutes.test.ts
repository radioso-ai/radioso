import express from "express";
import pg from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { HttpError } from "../shared/httpError.js";
import type { BillingCustomerPatch, BillingCustomerRepository, BillingCustomerRow } from "./billingCustomerRepository.js";
import { createBillingRoutes, type BillingConfig } from "./billingRoutes.js";
import type { StripeGateway, StripeWebhookEvent } from "./stripeGateway.js";
import { StripeSignatureVerificationError } from "./stripeGateway.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

// Auth/config tests never issue a query; a pool pointed at an unreachable address is fine because
// it's never connected. Mirrors `usageLimitRoutes.test.ts`.
const inertPool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });

const sessionAccountId = "11111111-1111-1111-1111-111111111111";
const sessionUserId = "22222222-2222-2222-2222-222222222222";

class FakeBillingCustomerRepository implements BillingCustomerRepository {
  rows = new Map<string, BillingCustomerRow>();

  async findByAccount(accountId: string): Promise<BillingCustomerRow | null> {
    return this.rows.get(accountId) ?? null;
  }

  async findByStripeCustomer(stripeCustomerId: string): Promise<BillingCustomerRow | null> {
    for (const row of this.rows.values()) {
      if (row.stripeCustomerId === stripeCustomerId) return row;
    }
    return null;
  }

  async upsertCustomer(patch: BillingCustomerPatch): Promise<BillingCustomerRow> {
    const hasOwn = (key: keyof BillingCustomerPatch): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);
    const existing = this.rows.get(patch.accountId);
    const now = new Date();
    const row: BillingCustomerRow = {
      accountId: patch.accountId,
      stripeCustomerId: patch.stripeCustomerId,
      stripeSubscriptionId: hasOwn("stripeSubscriptionId")
        ? patch.stripeSubscriptionId ?? null
        : existing?.stripeSubscriptionId ?? null,
      priceId: hasOwn("priceId") ? patch.priceId ?? null : existing?.priceId ?? null,
      interval: hasOwn("interval") ? patch.interval ?? null : existing?.interval ?? null,
      status: hasOwn("status") ? patch.status ?? "none" : existing?.status ?? "none",
      billingEmail: hasOwn("billingEmail") ? patch.billingEmail ?? null : existing?.billingEmail ?? null,
      currentPeriodEnd: hasOwn("currentPeriodEnd")
        ? patch.currentPeriodEnd ?? null
        : existing?.currentPeriodEnd ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(patch.accountId, row);
    return row;
  }

  async markEventProcessed(): Promise<boolean> {
    return true;
  }

  async withTransaction<T>(callback: (tx: BillingCustomerRepository) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const createFakeGateway = (overrides: Partial<StripeGateway> = {}): StripeGateway => ({
  findPriceByLookupKey: vi.fn(async (key: string) => ({ id: `price_${key}`, lookupKey: key, productId: `prod_${key}` })),
  getProduct: vi.fn(async (id: string) => ({ id, metadata: {} })),
  createCustomer: vi.fn(async () => ({ id: "cus_new" })),
  createCheckoutSession: vi.fn(async () => ({ url: "https://checkout.stripe.com/session/123" })),
  createPortalSession: vi.fn(async () => ({ url: "https://billing.stripe.com/portal/123" })),
  constructWebhookEvent: vi.fn(async (): Promise<StripeWebhookEvent> => {
    throw new Error("not stubbed");
  }),
  ...overrides,
});

const createDependencies = (
  database: RouteDependencies["connectorDb"],
  options: { auditRecord?: ReturnType<typeof vi.fn>; userEmail?: string | null } = {},
): RouteDependencies => ({
  connectorDb: database,
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
    APP_BASE_URL: "https://app.example.com",
  },
  apiPrincipalRouteInventory: {
    markAuthenticator<T>(handler: T) {
      return handler;
    },
    markRouteMount<T>(router: T) {
      return router;
    },
  },
  auditService: {
    record: options.auditRecord ?? vi.fn(async () => undefined),
  },
  authService: {
    async authenticateSession(token: string) {
      if (token !== "valid-session") {
        throw new HttpError(401, "unauthorized", "Unauthorized");
      }
      return { accountId: sessionAccountId, userId: sessionUserId, sessionId: "session-1" };
    },
    async authenticateApiToken() {
      throw new Error("API tokens are not used by billing routes");
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
    async requirePermission() {},
  },
  workspaceSessionService: {
    async resolve() {
      throw new Error("Workspace sessions are not used by billing routes");
    },
  },
  userRepository: {
    async findById() {
      return options.userEmail === undefined ? { email: "owner@example.com" } : options.userEmail === null ? null : { email: options.userEmail };
    },
  },
  workspaceRepository: {
    async findByAnonymousChatToken() {
      return null;
    },
  },
  mailService: {
    send: vi.fn(async () => undefined),
  },
} as unknown as RouteDependencies);

const createApp = (
  config: BillingConfig,
  overrides: { gateway?: StripeGateway; repository?: BillingCustomerRepository; dependencyOptions?: Parameters<typeof createDependencies>[1] } = {},
) => {
  const dependencies = createDependencies(inertPool as unknown as RouteDependencies["connectorDb"], overrides.dependencyOptions);
  const app = express();
  app.use(express.json());
  // The real app captures the raw body ahead of route mounts (`createApp.ts`'s
  // `captureRequestBody`); this test app fakes the same field so the webhook route's
  // `req.rawBody` read has something to find.
  app.use((req, _res, next) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(JSON.stringify(req.body ?? {}));
    next();
  });
  app.use((req, _res, next) => {
    const cookieHeader = req.header("cookie") ?? "";
    req.cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0])),
    );
    next();
  });
  app.use(
    "/api/v1/ee/billing",
    createBillingRoutes(dependencies, config, {
      gateway: overrides.gateway,
      repository: overrides.repository ?? new FakeBillingCustomerRepository(),
      usageService: {
        async getAccountUsage() {
          return { accountId: sessionAccountId, profile: null } as never;
        },
        async assignProfile() {
          return {} as never;
        },
        async addCredits() {
          return { credits: 0, applied: true };
        },
      },
    }),
  );
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: { code: payload.code ?? "internal_error", message: payload.message ?? "Internal error" },
    });
  });
  return app;
};

const unconfiguredConfig: BillingConfig = {
  configured: false,
  secretKey: null,
  webhookSecret: null,
  metadataKey: "plan",
};

const configuredConfig: BillingConfig = {
  configured: true,
  secretKey: "sk_test_123",
  webhookSecret: "whsec_123",
  metadataKey: "plan",
};

const withSessionCookie = (req: request.Test) => req.set("Cookie", "radioso_session=valid-session");

describe("GET /api/v1/ee/billing/me", () => {
  it("returns configured:false without touching the gateway when unconfigured", async () => {
    const response = await withSessionCookie(
      request(createApp(unconfiguredConfig)).get("/api/v1/ee/billing/me"),
    ).expect(200);

    expect(response.body).toEqual({ configured: false });
  });

  it("returns the default plan and hasCustomer:false for a comet account with no row", async () => {
    const response = await withSessionCookie(
      request(createApp(configuredConfig)).get("/api/v1/ee/billing/me"),
    ).expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        configured: true,
        planId: PLAN_CATALOG.defaultPlanId,
        status: "none",
        hasCustomer: false,
        interval: null,
        currentPeriodEnd: null,
      }),
    );
  });

  it("requires a session", async () => {
    await request(createApp(configuredConfig)).get("/api/v1/ee/billing/me").expect(401);
  });
});

describe("POST /api/v1/ee/billing/checkout", () => {
  it("returns 503 when billing is unconfigured", async () => {
    await withSessionCookie(
      request(createApp(unconfiguredConfig))
        .post("/api/v1/ee/billing/checkout")
        .send({ plan: "satellite", interval: "month", returnPath: "/usage" }),
    ).expect(503);
  });

  it("rejects a returnPath that is not a relative path", async () => {
    await withSessionCookie(
      request(createApp(configuredConfig, { gateway: createFakeGateway() }))
        .post("/api/v1/ee/billing/checkout")
        .send({ plan: "satellite", interval: "month", returnPath: "//evil.example.com" }),
    ).expect(400);
  });

  it("rejects a plan id the catalog does not recognize at all", async () => {
    await withSessionCookie(
      request(createApp(configuredConfig, { gateway: createFakeGateway() }))
        .post("/api/v1/ee/billing/checkout")
        .send({ plan: "not-a-plan", interval: "month", returnPath: "/usage" }),
    ).expect(400);
  });

  it("returns 409 plan_not_self_serve for a real catalog plan with no Stripe pricing", async () => {
    const response = await withSessionCookie(
      request(createApp(configuredConfig, { gateway: createFakeGateway() }))
        .post("/api/v1/ee/billing/checkout")
        .send({ plan: PLAN_CATALOG.defaultPlanId, interval: "month", returnPath: "/usage" }),
    ).expect(409);

    expect(response.body.error.code).toBe("plan_not_self_serve");
  });

  it("returns a checkout URL for a self-serve subscription plan", async () => {
    const gateway = createFakeGateway();
    const response = await withSessionCookie(
      request(createApp(configuredConfig, { gateway }))
        .post("/api/v1/ee/billing/checkout")
        .send({ plan: "satellite", interval: "month", returnPath: "/usage" }),
    ).expect(200);

    expect(response.body).toEqual({ url: "https://checkout.stripe.com/session/123" });
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "subscription", clientReferenceId: sessionAccountId }),
    );
  });

  it("returns a checkout URL for the top-up pack", async () => {
    const gateway = createFakeGateway();
    const response = await withSessionCookie(
      request(createApp(configuredConfig, { gateway }))
        .post("/api/v1/ee/billing/checkout")
        .send({ pack: true, returnPath: "/usage" }),
    ).expect(200);

    expect(response.body).toEqual({ url: "https://checkout.stripe.com/session/123" });
    expect(gateway.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "payment" }),
    );
  });
});

describe("POST /api/v1/ee/billing/portal", () => {
  it("returns 503 when billing is unconfigured", async () => {
    await withSessionCookie(
      request(createApp(unconfiguredConfig)).post("/api/v1/ee/billing/portal").send({ returnPath: "/usage" }),
    ).expect(503);
  });

  it("returns 404 no_billing_customer when the account has never checked out", async () => {
    const response = await withSessionCookie(
      request(createApp(configuredConfig, { gateway: createFakeGateway() }))
        .post("/api/v1/ee/billing/portal")
        .send({ returnPath: "/usage" }),
    ).expect(404);

    expect(response.body.error.code).toBe("no_billing_customer");
  });

  it("returns a portal URL for an account with a billing customer", async () => {
    const repository = new FakeBillingCustomerRepository();
    repository.rows.set(sessionAccountId, {
      accountId: sessionAccountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
      priceId: null,
      interval: null,
      status: "active",
      billingEmail: "owner@example.com",
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const gateway = createFakeGateway();

    const response = await withSessionCookie(
      request(createApp(configuredConfig, { gateway, repository }))
        .post("/api/v1/ee/billing/portal")
        .send({ returnPath: "/usage" }),
    ).expect(200);

    expect(response.body).toEqual({ url: "https://billing.stripe.com/portal/123" });
    expect(gateway.createPortalSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_1", returnUrl: "https://app.example.com/usage" }),
    );
  });
});

describe("POST /api/v1/ee/billing/webhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 503 when billing is unconfigured", async () => {
    await request(createApp(unconfiguredConfig)).post("/api/v1/ee/billing/webhook").send({}).expect(503);
  });

  it("returns 400 invalid_signature when the signature header is missing", async () => {
    await request(createApp(configuredConfig, { gateway: createFakeGateway() }))
      .post("/api/v1/ee/billing/webhook")
      .send({})
      .expect(400);
  });

  it("returns 400 invalid_signature when the gateway rejects the signature", async () => {
    const gateway = createFakeGateway({
      constructWebhookEvent: vi.fn(async () => {
        throw new StripeSignatureVerificationError();
      }),
    });

    const response = await request(createApp(configuredConfig, { gateway }))
      .post("/api/v1/ee/billing/webhook")
      .set("stripe-signature", "t=1,v1=bad")
      .send({ id: "evt_1" })
      .expect(400);

    expect(response.body.error.code).toBe("invalid_signature");
  });

  it("returns 200 with the outcome for a recognized event", async () => {
    const event: StripeWebhookEvent = { id: "evt_1", type: "payment_intent.succeeded" };
    const gateway = createFakeGateway({
      constructWebhookEvent: vi.fn(async () => event),
    });

    const response = await request(createApp(configuredConfig, { gateway }))
      .post("/api/v1/ee/billing/webhook")
      .set("stripe-signature", "t=1,v1=good")
      .send({ id: "evt_1" })
      .expect(200);

    expect(response.body).toEqual({ received: true, outcome: "ignored" });
  });
});
