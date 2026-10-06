import { expect, test, type Page, type Route } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from "./dashboard-fixtures";

// The backend's email channel is stubbed at the network layer in the shapes the `local` provider
// produces: DNS records start `pending`, a domain check flips them (as `email:dev verify-domain`
// does), and a setup check passes when the test delivers the message through the relay.

type DnsRecord = {
  purpose: "dkim" | "spf" | "return_path" | "receiving_mx" | "dmarc";
  type: "TXT" | "MX" | "CNAME";
  name: string;
  value: string;
  priority?: number;
  status: "pending" | "verified" | "failed" | "advisory";
};

type SetupCheck = {
  step: "base" | "plus_address";
  startedAt: string;
  status: "waiting" | "passed";
  passedAt: string | null;
  instructions: { sendTo: string };
};

type EmailEvent = {
  id: string;
  createdAt: string;
  state: "pending" | "fetched" | "ingested" | "done" | "failed";
  classification: string | null;
  disposition: "ingest_only" | "run_review_turn" | "drop" | null;
  reason: string | null;
  sender: { address: string | null; displayName: string | null };
  subject: string | null;
  auth: { spf: string; dkim: string; dmarc: string };
  spamVerdict: "spam" | "not_spam" | "unknown";
  conversationId: string | null;
  threadConflict: boolean;
  hasRaw: boolean;
  retryable: boolean;
};

const relayAddress = "r7f3k2m9q@in.radioso.test";
const rotatedRelayAddress = "r2x8w4n6p@in.radioso.test";
const mailboxId = "mailbox-support";
const domainId = "domain-customer";

const sendingRecords = (): DnsRecord[] => [
  { purpose: "dkim", type: "TXT", name: "resend._domainkey.customer.test", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4", status: "pending" },
  { purpose: "spf", type: "TXT", name: "send.customer.test", value: "v=spf1 include:amazonses.com ~all", status: "pending" },
  { purpose: "dmarc", type: "TXT", name: "_dmarc.customer.test", value: "v=DMARC1; p=none;", status: "advisory" },
];

const emailEvent = (overrides: Partial<EmailEvent> & Pick<EmailEvent, "id">): EmailEvent => ({
  createdAt: nowIso,
  state: "done",
  classification: "first_contact",
  disposition: "ingest_only",
  reason: null,
  sender: { address: "ana@example.test", displayName: "Ana Pereira" },
  subject: "Where is my order?",
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  spamVerdict: "not_spam",
  conversationId: null,
  threadConflict: false,
  hasRaw: true,
  retryable: false,
  ...overrides,
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const refuse = (route: Route, status: number, code: string, message: string) =>
  json(route, { error: { code, message } }, status);

type EngagementMode = "operator_only" | "draft" | "auto";

// The request field that opts a mailbox into `auto`; the backend refuses the switch without it.
const AUTO_OPT_IN_FIELD = "autoOptIn";

type MailboxLimits = {
  threadSendBudget: number;
  hourlyGenerationBudget: number;
  silenceThresholdHours: number;
};
const LIMIT_FIELDS = ["threadSendBudget", "hourlyGenerationBudget", "silenceThresholdHours"] as const;
// Mode, enabled and agent are the mailbox's policy; only a change to one of them writes a new version.
const POLICY_FIELDS = ["engagementMode", "enabled", "agentId"] as const;

/**
 * In-memory email channel backend; `deliver` stands in for mail arriving through the relay, and
 * `changePolicyElsewhere` for a teammate saving this mailbox's settings in another tab.
 */
const installEmailChannelBackend = async (
  page: Page,
  options: { supportedModes?: EngagementMode[]; existingMailbox?: { engagementMode: EngagementMode } } = {},
) => {
  const supportedModes = options.supportedModes ?? ["operator_only"];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const domains: Array<{
    id: string;
    domain: string;
    sending: { status: "pending" | "verified" | "failed"; checkedAt: string | null };
    receiving: { status: "not_requested" | "pending" | "verified" | "failed"; checkedAt: string | null };
    records: DnsRecord[];
  }> = [];
  const mailboxes: Array<Record<string, unknown> & {
    id: string;
    receiving: { state: string; lastReceivedAt: string | null };
    sending: { state: string };
    setupCheck: SetupCheck | null;
  }> = [];
  const events: EmailEvent[] = [
    emailEvent({
      id: "delivery-confirmation",
      classification: "forwarding_confirmation",
      disposition: "drop",
      reason: "forwarding_confirmation",
      sender: { address: "forwarding-noreply@google.com", displayName: "Gmail Team" },
      subject: "Gmail Forwarding Confirmation",
    }),
    emailEvent({
      id: "delivery-failed",
      state: "failed",
      disposition: null,
      reason: "fetch_failed",
      sender: { address: "bo@example.test", displayName: null },
      subject: "Refund request",
      hasRaw: false,
      retryable: true,
    }),
  ];
  let verifyCount = 0;

  const newMailbox = (input: { address: string; displayName: unknown; agentId: unknown; engagementMode: unknown }) => ({
    id: mailboxId,
    address: input.address,
    displayName: input.displayName,
    agentId: input.agentId ?? null,
    domainId,
    relayAddress,
    engagementMode: input.engagementMode ?? "operator_only",
    enabled: true,
    policyVersion: 1,
    threadSendBudget: 3,
    hourlyGenerationBudget: 30,
    silenceThresholdHours: 72,
    receiving: { state: "waiting_for_first_message", lastReceivedAt: null },
    sending: { state: "not_verified" },
    plusAddressVerified: false,
    setupCheck: null,
  });

  if (options.existingMailbox) {
    domains.push({
      id: domainId,
      domain: "customer.test",
      sending: { status: "pending", checkedAt: null },
      receiving: { status: "not_requested", checkedAt: null },
      records: sendingRecords(),
    });
    mailboxes.push(newMailbox({
      address: "support@customer.test",
      displayName: "Support",
      agentId: defaultAgentId,
      engagementMode: options.existingMailbox.engagementMode,
    }));
  }

  const overview = () => ({
    configured: true,
    inboundDomain: "in.radioso.test",
    supportedModes,
    defaultMode: supportedModes.includes("draft") ? "draft" : "operator_only",
    domains,
    mailboxes,
  });

  const deliver = (step: SetupCheck["step"]) => {
    const mailbox = mailboxes[0];
    if (!mailbox?.setupCheck || mailbox.setupCheck.step !== step) throw new Error(`No ${step} check is waiting`);
    mailbox.setupCheck = { ...mailbox.setupCheck, status: "passed", passedAt: nowIso };
    mailbox.receiving = { state: "ok", lastReceivedAt: nowIso };
    if (step === "plus_address") mailbox.plusAddressVerified = true;
  };

  await page.route("**/backend/api/v1/workspaces/*/email-channel**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(`/backend/api/v1/workspaces/${workspaceId}/email-channel`, "");
    const body = request.postDataJSON() as Record<string, unknown> | null;
    requests.push({ method, path, ...(body ? { body } : {}) });

    if (method === "GET" && path === "") return json(route, overview());

    if (method === "POST" && path === "/mailboxes") {
      const address = typeof body?.address === "string" ? body.address : "";
      const domainName = address.split("@")[1] ?? "";
      if (domainName === "taken.test") {
        return refuse(route, 409, "domain_claimed_elsewhere", "Domain is claimed elsewhere");
      }
      if (!domains.some((domain) => domain.domain === domainName)) {
        domains.push({
          id: domainId,
          domain: domainName,
          sending: { status: "pending", checkedAt: null },
          receiving: { status: "not_requested", checkedAt: null },
          records: sendingRecords(),
        });
      }
      const mailbox = newMailbox({
        address,
        displayName: body?.displayName,
        agentId: body?.agentId,
        engagementMode: body?.engagementMode,
      });
      mailboxes.push(mailbox);
      return json(route, mailbox, 201);
    }

    if (method === "GET" && path === `/mailboxes/${mailboxId}`) return json(route, mailboxes[0]);

    if (method === "PATCH" && path === `/mailboxes/${mailboxId}`) {
      const mailbox = mailboxes[0];
      if (body?.expectedPolicyVersion !== undefined && body.expectedPolicyVersion !== mailbox.policyVersion) {
        return refuse(route, 409, "stale_policy_version", "The mailbox's settings changed since they were read");
      }
      if (typeof body?.engagementMode === "string" && !supportedModes.includes(body.engagementMode as EngagementMode)) {
        return refuse(route, 409, "engagement_mode_unavailable", "That mode is not available");
      }
      if (body?.engagementMode === "auto" && mailbox.engagementMode !== "auto" && body[AUTO_OPT_IN_FIELD] !== true) {
        return refuse(route, 400, "auto_opt_in_required", "Switching to auto needs an explicit opt-in");
      }
      const policyChanged = POLICY_FIELDS.some((field) => body?.[field] !== undefined && body[field] !== mailbox[field]);
      for (const field of [...POLICY_FIELDS, ...LIMIT_FIELDS]) {
        if (body?.[field] !== undefined) mailbox[field] = body[field];
      }
      if (policyChanged) mailbox.policyVersion = (mailbox.policyVersion as number) + 1;
      return json(route, mailbox);
    }

    if (method === "POST" && path === `/mailboxes/${mailboxId}/relay-token/rotate`) {
      // The previous address keeps forwarding for the grace period; the mailbox shows the new one.
      mailboxes[0].relayAddress = rotatedRelayAddress;
      return json(route, mailboxes[0]);
    }

    if (method === "POST" && path === `/mailboxes/${mailboxId}/setup-check`) {
      const step = body?.step as SetupCheck["step"];
      const check: SetupCheck = {
        step,
        startedAt: nowIso,
        status: "waiting",
        passedAt: null,
        instructions: { sendTo: step === "base" ? "support@customer.test" : "support+radioso-check@customer.test" },
      };
      mailboxes[0].setupCheck = check;
      return json(route, check);
    }

    if (method === "GET" && path === `/mailboxes/${mailboxId}/events`) return json(route, { items: events, nextCursor: null });

    if (method === "POST" && path === "/events/delivery-failed/retry") {
      const retried = { ...events[1], state: "pending" as const, reason: null, retryable: false };
      events[1] = retried;
      return json(route, retried, 202);
    }

    if (method === "GET" && path === "/events/delivery-confirmation/raw") {
      return json(route, {
        headers: [
          { name: "From", value: "Gmail Team <forwarding-noreply@google.com>" },
          { name: "Subject", value: "Gmail Forwarding Confirmation" },
        ],
        text: "Confirmation code: 482913",
        sanitizedHtml: "<p>Confirmation code: 482913</p>",
        truncated: false,
        attachments: [],
      });
    }

    if (method === "POST" && path === "/domains") {
      return refuse(route, 409, "domain_claimed_elsewhere", "Domain is claimed elsewhere");
    }

    if (method === "POST" && path === `/domains/${domainId}/verify`) {
      verifyCount += 1;
      const domain = domains[0];
      // The first check finds DKIM only, the second finds everything: a partial state on the way.
      domain.records = domain.records.map((record) =>
        record.status === "advisory" || (verifyCount === 1 && record.purpose !== "dkim") ? record : { ...record, status: "verified" });
      if (verifyCount > 1) {
        domain.sending = { status: "verified", checkedAt: nowIso };
        mailboxes.forEach((mailbox) => { mailbox.sending = { state: "ok" }; });
      }
      return json(route, domain);
    }

    if (method === "POST" && path === `/domains/${domainId}/receiving`) {
      const domain = domains[0];
      if (body?.confirmation !== domain.domain) {
        return refuse(route, 400, "confirmation_mismatch", "Confirmation does not match the domain");
      }
      domain.receiving = { status: "pending", checkedAt: null };
      domain.records = [...domain.records, { purpose: "receiving_mx", type: "MX", name: domain.domain, value: "inbound.radioso.test", priority: 10, status: "pending" }];
      return json(route, domain);
    }

    return refuse(route, 404, "not_found", `Unhandled email channel route: ${method} ${path}`);
  });

  const changePolicyElsewhere = (limits: Partial<MailboxLimits> = {}) => {
    const mailbox = mailboxes[0];
    Object.assign(mailbox, limits);
    mailbox.policyVersion = (mailbox.policyVersion as number) + 1;
  };

  return { requests, deliver, changePolicyElsewhere };
};

const openEmailChannel = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels&anchor=email-channel`);
  await expect(page.getByRole("heading", { name: "Email", level: 3 })).toBeVisible();
};

// The card's one polite live region; spinners are `status` too, so match the live region itself.
const announcer = (page: Page) => page.locator('#email-channel [aria-live="polite"]');

test("operator adds a mailbox, forwards to its relay address, and passes the setup check", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page);

  await openEmailChannel(page);
  const card = page.locator("#email-channel");
  await expect(card.getByText("No mailboxes yet.")).toBeVisible();

  // The mode selector offers only what this server supports.
  const modes = card.getByRole("group", { name: "Mode" });
  await expect(modes.getByRole("button")).toHaveText(["Operator only"]);

  // A domain another workspace owns is refused without naming that workspace.
  await card.getByLabel("Address", { exact: true }).fill("help@taken.test");
  await card.getByLabel("Display name").fill("Help");
  await card.getByRole("button", { name: "Add mailbox" }).click();
  await expect(card.getByRole("alert")).toHaveText("This domain is claimed by another workspace.");
  await expect(card.getByRole("button", { name: "Add mailbox" })).toBeFocused();

  await card.getByLabel("Address", { exact: true }).fill("support@customer.test");
  await card.getByLabel("Display name").fill("Support");
  await card.getByRole("button", { name: "Add mailbox" }).click();

  await expect(announcer(page)).toHaveText("Mailbox added.");
  await expect(card.getByRole("heading", { name: "support@customer.test" })).toBeFocused();
  expect(backend.requests).toContainEqual({
    method: "POST",
    path: "/mailboxes",
    body: { address: "support@customer.test", displayName: "Support", agentId: defaultAgentId, engagementMode: "operator_only" },
  });

  const mailbox = card.getByRole("region", { name: "support@customer.test" });
  await expect(mailbox.getByText("Receiving: Waiting for first message")).toBeVisible();
  await expect(mailbox.getByText("Sending: Not verified")).toBeVisible();

  // The relay address copies as is.
  await expect(mailbox.getByText(relayAddress)).toBeVisible();
  await mailbox.getByRole("button", { name: "Copy relay address" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(relayAddress);

  // Forwarding guidance: Google confirms through the raw view; Microsoft 365 needs the policy first.
  await expect(mailbox.getByRole("tab", { name: "Google Workspace" })).toHaveAttribute("aria-selected", "true");
  await expect(mailbox.getByRole("tabpanel").getByRole("listitem")).toHaveCount(3);
  await expect(mailbox.getByRole("tabpanel")).toContainText("View raw");
  await mailbox.getByRole("tab", { name: "Microsoft 365" }).click();
  const microsoftSteps = mailbox.getByRole("tabpanel").getByRole("listitem");
  await expect(microsoftSteps).toHaveCount(2);
  await expect(microsoftSteps.nth(0)).toContainText("outbound anti-spam policy");
  await expect(microsoftSteps.nth(1)).toContainText("forwarding rule");

  // Setup check: the base address, then the plus address, each waiting until mail arrives.
  await mailbox.getByRole("button", { name: "Run setup check" }).click();
  await expect(mailbox.getByText("Send any message to support@customer.test.")).toBeVisible();
  await expect(announcer(page)).toHaveText("Waiting for a message to support@customer.test.");
  backend.deliver("base");

  await expect(mailbox.getByText("Send any message to support+radioso-check@customer.test.")).toBeVisible();
  await expect(mailbox.getByText(/^Receiving: OK/)).toBeVisible();
  backend.deliver("plus_address");

  await expect(mailbox.getByText("Forwarding works.")).toBeVisible();
  await expect(announcer(page)).toHaveText("Setup check passed.");
});

test("upgrading an existing mailbox from Operator only to Draft for review asks once, says it applies to new mail, and keeps focus", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft"],
    existingMailbox: { engagementMode: "operator_only" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const mode = mailbox.getByRole("group", { name: "Mailbox mode" });
  await expect(mode.getByRole("button")).toHaveText(["Operator only", "Draft for review"]);
  await expect(mode.getByRole("button", { name: "Operator only" })).toHaveAttribute("aria-pressed", "true");

  await mode.getByRole("button", { name: "Draft for review" }).click();
  // An upgrade reaches new mail only, and drafts already waiting are discarded.
  const confirmation = mailbox.getByRole("group", { name: "Confirm mode change" });
  await expect(confirmation).toHaveText(/^Change to Draft for review\? Applies to new mail only; pending drafts are discarded\./);
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  await confirmation.getByRole("button", { name: "Confirm" }).click();

  await expect(announcer(page)).toHaveText("Mode changed to Draft for review. It applies to new mail.");
  await expect(mode.getByRole("button", { name: "Draft for review" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Draft for review" })).toBeFocused();
  await expect(mailbox.getByText("Support · Mode: Draft for review")).toBeVisible();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([
    { method: "PATCH", path: `/mailboxes/${mailboxId}`, body: { engagementMode: "draft", expectedPolicyVersion: 1 } },
  ]);
});

test("downgrading a draft mailbox asks once, says pending and queued replies are discarded, then keeps focus on the mode", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft"],
    existingMailbox: { engagementMode: "draft" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const mode = mailbox.getByRole("group", { name: "Mailbox mode" });
  await mode.getByRole("button", { name: "Operator only" }).click();

  const confirmation = mailbox.getByRole("group", { name: "Confirm mode change" });
  await expect(confirmation.getByText("Change to Operator only? Pending and queued replies are discarded.")).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([]);

  // Cancelling changes nothing and returns focus to the mode.
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(mode.getByRole("button", { name: "Draft for review" })).toBeFocused();

  await mode.getByRole("button", { name: "Operator only" }).click();
  await mailbox.getByRole("group", { name: "Confirm mode change" }).getByRole("button", { name: "Confirm" }).click();

  await expect(announcer(page)).toHaveText("Mode changed to Operator only.");
  await expect(mode.getByRole("button", { name: "Operator only" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Operator only" })).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([
    { method: "PATCH", path: `/mailboxes/${mailboxId}`, body: { engagementMode: "operator_only", expectedPolicyVersion: 1 } },
  ]);
});

test("a mode change against settings saved elsewhere is refused, reloads the mailbox, and then goes through", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft"],
    existingMailbox: { engagementMode: "operator_only" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const mode = mailbox.getByRole("group", { name: "Mailbox mode" });
  await expect(mode).toBeVisible();
  backend.changePolicyElsewhere();
  const confirm = mailbox.getByRole("group", { name: "Confirm mode change" }).getByRole("button", { name: "Confirm" });

  await mode.getByRole("button", { name: "Draft for review" }).click();
  await confirm.click();

  await expect(mailbox.getByRole("alert")).toHaveText("Settings changed elsewhere, reloaded.");
  await expect(mode.getByRole("button", { name: "Operator only" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Operator only" })).toBeFocused();

  await mode.getByRole("button", { name: "Draft for review" }).click();
  await confirm.click();
  await expect(announcer(page)).toHaveText("Mode changed to Draft for review. It applies to new mail.");
  await expect(mailbox.getByRole("alert")).toHaveCount(0);
  expect(backend.requests.filter((request) => request.method === "PATCH").map((request) => request.body)).toEqual([
    { engagementMode: "draft", expectedPolicyVersion: 1 },
    { engagementMode: "draft", expectedPolicyVersion: 2 },
  ]);
});

test("turning on Automatic asks once with the thread send budget, and cancelling changes nothing", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft", "auto"],
    existingMailbox: { engagementMode: "draft" },
  });

  await openEmailChannel(page);
  const card = page.locator("#email-channel");
  const mailbox = card.getByRole("region", { name: "support@customer.test" });
  const mode = mailbox.getByRole("group", { name: "Mailbox mode" });
  await expect(mode.getByRole("button")).toHaveText(["Operator only", "Draft for review", "Automatic"]);
  // A new mailbox never starts in Automatic: the opt-in happens on an existing one.
  await expect(card.getByRole("group", { name: "Mode", exact: true }).getByRole("button")).toHaveText(["Operator only", "Draft for review"]);

  await mode.getByRole("button", { name: "Automatic" }).click();
  const confirmation = mailbox.getByRole("group", { name: "Confirm mode change" });
  await expect(confirmation).toHaveText(new RegExp(
    "^Change to Automatic\\? The agent sends grounded replies on its own, up to 3 per thread until an operator replies\\. "
      + "Applies to new mail only; pending drafts are discarded\\.",
  ));
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();

  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(mode.getByRole("button", { name: "Draft for review" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Draft for review" })).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([]);

  await mode.getByRole("button", { name: "Automatic" }).click();
  await mailbox.getByRole("group", { name: "Confirm mode change" }).getByRole("button", { name: "Confirm" }).click();

  await expect(announcer(page)).toHaveText("Mode changed to Automatic. It applies to new mail.");
  await expect(mode.getByRole("button", { name: "Automatic" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Automatic" })).toBeFocused();
  await expect(mailbox.getByText("Support · Mode: Automatic")).toBeVisible();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([
    {
      method: "PATCH",
      path: `/mailboxes/${mailboxId}`,
      body: { engagementMode: "auto", expectedPolicyVersion: 1, [AUTO_OPT_IN_FIELD]: true },
    },
  ]);
});

test("leaving Automatic says queued replies are held for review under Draft for review, and discarded under Operator only", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft", "auto"],
    existingMailbox: { engagementMode: "auto" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const mode = mailbox.getByRole("group", { name: "Mailbox mode" });
  const confirmation = mailbox.getByRole("group", { name: "Confirm mode change" });
  await expect(mode.getByRole("button", { name: "Automatic" })).toHaveAttribute("aria-pressed", "true");

  await mode.getByRole("button", { name: "Operator only" }).click();
  await expect(confirmation.getByText("Change to Operator only? Pending and queued replies are discarded.")).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(mode.getByRole("button", { name: "Automatic" })).toBeFocused();

  await mode.getByRole("button", { name: "Draft for review" }).click();
  await expect(confirmation.getByText("Change to Draft for review? Queued automatic replies are held for your review.")).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([]);
  await confirmation.getByRole("button", { name: "Confirm" }).click();

  await expect(announcer(page)).toHaveText("Mode changed to Draft for review.");
  await expect(mode.getByRole("button", { name: "Draft for review" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Draft for review" })).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([
    { method: "PATCH", path: `/mailboxes/${mailboxId}`, body: { engagementMode: "draft", expectedPolicyVersion: 1 } },
  ]);
});

test("operator edits a mailbox's limits, keeping focus, and the Automatic confirmation shows the new send budget", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft", "auto"],
    existingMailbox: { engagementMode: "draft" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const limits = mailbox.getByRole("form", { name: "Limits" });
  const sendBudget = limits.getByLabel("Replies per thread");
  await expect(sendBudget).toHaveValue("3");

  const advanced = limits.getByRole("button", { name: "Advanced" });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(limits.getByLabel("Agent runs per hour")).toHaveValue("30");
  await expect(limits.getByLabel("Silence alert (hours)")).toHaveValue("72");

  // Out of the contract's bounds: named inline, and nothing is sent.
  const save = limits.getByRole("button", { name: "Save limits" });
  await sendBudget.fill("25");
  await expect(sendBudget).toHaveAttribute("aria-invalid", "true");
  await expect(limits.getByText("Enter a whole number from 1 to 20.")).toBeVisible();
  await save.click();
  await expect(sendBudget).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([]);

  await sendBudget.fill("5");
  await save.click();

  await expect(announcer(page)).toHaveText("Limits saved.");
  await expect(save).toBeFocused();
  await expect(sendBudget).toHaveValue("5");
  await expect(sendBudget).not.toHaveAttribute("aria-invalid", "true");
  expect(backend.requests.filter((request) => request.method === "PATCH")).toEqual([
    {
      method: "PATCH",
      path: `/mailboxes/${mailboxId}`,
      body: { threadSendBudget: 5, expectedPolicyVersion: 1 },
    },
  ]);

  await mailbox.getByRole("group", { name: "Mailbox mode" }).getByRole("button", { name: "Automatic" }).click();
  await expect(mailbox.getByRole("group", { name: "Confirm mode change" })).toContainText("up to 5 per thread until an operator replies.");
});

test("a limits save against settings saved elsewhere is refused and reloads the mailbox", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft", "auto"],
    existingMailbox: { engagementMode: "draft" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const limits = mailbox.getByRole("form", { name: "Limits" });
  await expect(limits.getByLabel("Replies per thread")).toHaveValue("3");
  backend.changePolicyElsewhere({ threadSendBudget: 4 });

  await limits.getByRole("button", { name: "Advanced" }).click();
  await limits.getByLabel("Agent runs per hour").fill("60");
  const save = limits.getByRole("button", { name: "Save limits" });
  await save.click();

  await expect(limits.getByRole("alert")).toHaveText("Settings changed elsewhere, reloaded.");
  await expect(limits.getByLabel("Replies per thread")).toHaveValue("4");
  await expect(limits.getByLabel("Agent runs per hour")).toHaveValue("30");
  await expect(save).toBeFocused();
  expect(backend.requests.filter((request) => request.method === "PATCH").map((request) => request.body)).toEqual([
    { hourlyGenerationBudget: 60, expectedPolicyVersion: 1 },
  ]);
});

test("disabling a mailbox asks once, says waiting drafts are discarded and go to a person, and enabling it again needs no confirmation", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft"],
    existingMailbox: { engagementMode: "draft" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  const patches = () => backend.requests.filter((request) => request.method === "PATCH");

  await mailbox.getByRole("button", { name: "Disable mailbox" }).click();
  const confirmation = mailbox.getByRole("group", { name: "Confirm disabling the mailbox" });
  await expect(confirmation).toContainText("Mail to support@customer.test is only logged until you enable it again.");
  await expect(confirmation).toContainText("Pending drafts are discarded and their conversations go to a person.");
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(patches()).toEqual([]);

  // Cancelling changes nothing.
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(mailbox.getByRole("button", { name: "Disable mailbox" })).toBeFocused();
  expect(patches()).toEqual([]);

  await mailbox.getByRole("button", { name: "Disable mailbox" }).click();
  await confirmation.getByRole("button", { name: "Confirm" }).click();
  await expect(announcer(page)).toHaveText("Mailbox disabled.");
  await expect(mailbox.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(mailbox.getByRole("button", { name: "Enable mailbox" })).toBeFocused();

  await mailbox.getByRole("button", { name: "Enable mailbox" }).click();
  await expect(announcer(page)).toHaveText("Mailbox enabled. It applies to new mail.");
  await expect(mailbox.getByText("Disabled", { exact: true })).toHaveCount(0);
  await expect(mailbox.getByRole("button", { name: "Disable mailbox" })).toBeFocused();
  expect(patches()).toEqual([
    { method: "PATCH", path: `/mailboxes/${mailboxId}`, body: { enabled: false, expectedPolicyVersion: 1 } },
    { method: "PATCH", path: `/mailboxes/${mailboxId}`, body: { enabled: true, expectedPolicyVersion: 2 } },
  ]);
});

test("disabling a mailbox whose settings were saved elsewhere is refused and reloads it", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, {
    supportedModes: ["operator_only", "draft"],
    existingMailbox: { engagementMode: "draft" },
  });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  backend.changePolicyElsewhere();
  await mailbox.getByRole("button", { name: "Disable mailbox" }).click();
  await mailbox.getByRole("group", { name: "Confirm disabling the mailbox" }).getByRole("button", { name: "Confirm" }).click();

  await expect(mailbox.getByRole("alert")).toHaveText("Settings changed elsewhere, reloaded.");
  await expect(mailbox.getByText("Disabled", { exact: true })).toHaveCount(0);
  await expect(mailbox.getByRole("button", { name: "Disable mailbox" })).toBeFocused();
});

test("replacing the relay address asks once with the grace period, then shows the new address", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page, { existingMailbox: { engagementMode: "operator_only" } });

  await openEmailChannel(page);
  const mailbox = page.locator("#email-channel").getByRole("region", { name: "support@customer.test" });
  await expect(mailbox.getByText(relayAddress)).toBeVisible();
  const rotations = () => backend.requests.filter((request) => request.path.endsWith("/relay-token/rotate"));

  await mailbox.getByRole("button", { name: "Replace relay address" }).click();
  const confirmation = mailbox.getByRole("group", { name: "Confirm replacing the relay address" });
  await expect(confirmation).toContainText("The current address keeps working for 7 days. Point your forwarding at the new one before then.");
  await expect(confirmation.getByRole("button", { name: "Confirm" })).toBeFocused();
  expect(rotations()).toEqual([]);
  await confirmation.getByRole("button", { name: "Confirm" }).click();

  await expect(mailbox.getByText(rotatedRelayAddress)).toBeVisible();
  await expect(mailbox.getByText(relayAddress)).toHaveCount(0);
  await expect(announcer(page)).toHaveText("New relay address issued. Update your forwarding within 7 days.");
  await expect(mailbox.getByRole("button", { name: "Replace relay address" })).toBeFocused();
  expect(rotations()).toEqual([{ method: "POST", path: `/mailboxes/${mailboxId}/relay-token/rotate` }]);
});

test("operator copies DNS records, checks them, and enables direct receiving with a typed confirmation", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page);

  await openEmailChannel(page);
  const card = page.locator("#email-channel");
  await card.getByLabel("Address", { exact: true }).fill("support@customer.test");
  await card.getByLabel("Display name").fill("Support");
  await card.getByRole("button", { name: "Add mailbox" }).click();

  const domain = card.getByRole("region", { name: "customer.test", exact: true });
  await expect(domain.getByText("Sending: Pending")).toBeVisible();
  const dkim = domain.getByRole("row", { name: /DKIM/ });
  await expect(dkim.getByText("Pending", { exact: true })).toBeVisible();
  await expect(domain.getByRole("row", { name: /DMARC/ }).getByText("Recommended", { exact: true })).toBeVisible();
  await dkim.getByRole("button", { name: "Copy DKIM value" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("p=MIGfMA0GCSqGSIb3DQEBAQUAA4");

  // The first check finds only DKIM: a partial state, record by record.
  const checkDns = domain.getByRole("button", { name: "Check DNS" });
  await checkDns.click();
  await expect(dkim.getByText("Verified", { exact: true })).toBeVisible();
  await expect(domain.getByRole("row", { name: /SPF/ }).getByText("Pending", { exact: true })).toBeVisible();
  await expect(domain.getByText("1 of 2 required records verified.")).toBeVisible();
  await expect(announcer(page)).toHaveText("DNS checked. 1 of 2 required records verified.");
  await expect(checkDns).toBeFocused();

  await checkDns.click();
  await expect(domain.getByText("Sending: Verified")).toBeVisible();
  await expect(card.getByRole("region", { name: "support@customer.test" }).getByText("Sending: OK")).toBeVisible();

  // A second domain someone else owns is refused without naming them.
  await card.getByLabel("Domain", { exact: true }).fill("taken.test");
  await card.getByRole("button", { name: "Add domain" }).click();
  await expect(card.getByRole("alert")).toHaveText("This domain is claimed by another workspace.");

  // Direct receiving routes the whole domain, so it waits for the domain to be typed.
  await domain.getByRole("button", { name: "Direct receiving" }).click();
  await expect(domain.getByText("All mail for customer.test will route to Radioso.")).toBeVisible();
  const enable = domain.getByRole("button", { name: "Enable direct receiving" });
  await expect(enable).toBeDisabled();
  await domain.getByLabel("Type customer.test to confirm").fill("customer.tes");
  await expect(enable).toBeDisabled();
  await domain.getByLabel("Type customer.test to confirm").fill("customer.test");
  await enable.click();
  await expect(domain.getByText("Receiving: Pending")).toBeVisible();
  await expect(domain.getByRole("row", { name: /Receiving MX/ }).getByText("Pending", { exact: true })).toBeVisible();
  await expect(announcer(page)).toHaveText("Direct receiving requested.");
  expect(backend.requests).toContainEqual({ method: "POST", path: `/domains/${domainId}/receiving`, body: { confirmation: "customer.test" } });
});

test("operator retries a failed event and reads a forwarding confirmation in the raw view", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);
  const backend = await installEmailChannelBackend(page);

  await openEmailChannel(page);
  const card = page.locator("#email-channel");
  await card.getByLabel("Address", { exact: true }).fill("support@customer.test");
  await card.getByLabel("Display name").fill("Support");
  await card.getByRole("button", { name: "Add mailbox" }).click();
  const mailbox = card.getByRole("region", { name: "support@customer.test" });

  await mailbox.getByRole("button", { name: "Events" }).click();
  const failed = mailbox.getByRole("listitem").filter({ hasText: "Refund request" });
  await expect(failed.getByText("Failed", { exact: true })).toBeVisible();
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed.getByText("Processing", { exact: true })).toBeVisible();
  await expect(failed.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(failed).toBeFocused();
  await expect(announcer(page)).toHaveText("Retry queued.");
  expect(backend.requests).toContainEqual({ method: "POST", path: "/events/delivery-failed/retry" });

  const confirmation = mailbox.getByRole("listitem").filter({ hasText: "Gmail Forwarding Confirmation" });
  await confirmation.getByRole("button", { name: "View raw" }).click();
  const raw = page.getByRole("dialog", { name: "Raw message" });
  await expect(raw.getByText("Confirmation code: 482913")).toBeVisible();
  await expect(raw.getByText("Gmail Team <forwarding-noreply@google.com>")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation.getByRole("button", { name: "View raw" })).toBeFocused();
});

test("an operator-only email conversation shows its sender and subject, and the composer explains it cannot send", async ({ page }) => {
  const conversationId = "conversation-email";
  const ownership = {
    conversationId,
    workspaceId,
    state: "human_owned" as const,
    ownerAccountId: null,
    ownerUserId: null,
    ownerDisplayName: null,
    reason: "operator_only_mailbox",
    version: 1,
    takenOverAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const channelContext = {
    provider: "email",
    mailbox: { id: mailboxId, address: "support@customer.test" },
    threadKey: "8b3c1f4e-1d2a-4c5b-9e7f-0a1b2c3d4e5f",
    participant: { address: "ana@example.test" },
  };
  const conversation = {
    id: conversationId,
    agentId: defaultAgentId,
    agentName: "Gioia",
    sourceChannel: "email",
    sourceOrigin: null,
    anonymousSessionId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageCount: 1,
    userMessageCount: 1,
    assistantMessageCount: 0,
    preview: "Where is my order?",
    ownership,
    channelContext,
  };
  const replies: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    historyList: { conversations: [conversation], total: 1, nextCursor: null, hasMore: false },
    conversationDetails: {
      [conversationId]: {
        ...conversation,
        conversationId,
        workspaceId,
        messagesTotal: 1,
        messageWindowOffset: 0,
        messageWindowLimit: 50,
        hasOlderMessages: false,
        nextCursor: null,
        messages: [{ id: "message-1", role: "user", source: "customer", content: "Order 4417 never arrived.", createdAt: nowIso }],
      },
    },
  });
  await page.route("**/backend/api/v1/quality/turns**", (route) =>
    json(route, { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }));
  await page.route(`**/backend/api/v1/conversations/${conversationId}/email`, (route) => json(route, {
    mailbox: { id: mailboxId, address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
    participant: { address: "ana@example.test", displayName: "Ana Pereira" },
    latest: { subject: "Where is my order?", cc: [], inboundAt: nowIso },
    sending: { state: "ok" },
    sendBudget: { used: 0, limit: 3, renewedAt: null },
    messages: [],
  }));
  await page.route(`**/backend/api/v1/conversations/${conversationId}/reply`, (route) => {
    replies.push(route.request().postDataJSON());
    return refuse(route, 409, "email_sending_not_available", "Replies to email conversations cannot be sent yet.");
  });

  await page.goto(`/w/${workspaceKey}/activity`);
  await page.getByLabel("Inbox queue").getByRole("button", { name: /Where is my order/ }).click();

  const response = page.getByLabel("Response", { exact: true });
  const header = response.getByRole("region", { name: "Email", exact: true });
  await expect(header.getByText("Ana Pereira <ana@example.test>")).toBeVisible();
  await expect(header.getByText("Where is my order?")).toBeVisible();
  await expect(header.getByText("support@customer.test")).toBeVisible();

  const replyBox = response.getByRole("textbox", { name: "Reply to the visitor" });
  await replyBox.fill("We are tracking it now.");
  await response.getByRole("button", { name: "Send" }).click();

  await expect(response.getByText("Replies to email conversations cannot be sent yet.")).toBeVisible();
  await expect(replyBox).toHaveValue("We are tracking it now.");
  await expect(replyBox).toBeFocused();
  expect(replies).toHaveLength(1);
  // The mailbox read after the refusal still says it can send, so Send is offered again and the
  // refusal stays said until the next attempt.
  await expect(response.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(response.getByText("Replies to email conversations cannot be sent yet.")).toBeVisible();
});
