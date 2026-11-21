import { expect, test, type Route } from "@playwright/test";

import {
  baseSkillCapabilities,
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
} from "./dashboard-fixtures";

const connectionId = "99999999-9999-4999-8999-999999999999";
const stamp = "2026-01-01T00:00:00.000Z";

type StoredConnection = {
  id: string;
  name: string;
  baseUrl: string;
  authScheme: string;
  authHeaderName: string | null;
  credentialMask: string | null;
  defaultHeaders: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

const fulfillJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const apiRequestCapability = () => ({
  id: "api_request" as const,
  storedKind: "api_request",
  targetKind: "api_connection",
  requiresTarget: true,
  inputSchema: { source: "static" as const, schema: { fields: [], required: [] } },
  settingsFields: [],
  outcomeVocabulary: ["completed", "not_found", "rejected", "missing_input", "invalid_input", "unverified", "failed"],
  supportedInvocationModes: ["routine_named" as const],
  defaultInvocationMode: "routine_named" as const,
  executorAdapter: "api_request",
  targets: [] as Array<{ id: string; label: string }>,
  available: false,
  unavailableReason: "no_connection" as string | null,
});

test("an operator connects an API, sends a test request and declares an output from the response", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // A response value far wider than the dialog, such as a user agent string.
  const longValue = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:97.0) Gecko/20100101 Firefox/97.0 ${"x".repeat(160)}`;

  const connections: StoredConnection[] = [];
  const connectionBodies: unknown[] = [];
  const testRequests: unknown[] = [];
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];
  const agentSkills: AgentSkillFixture[] = [];
  const capabilities = baseSkillCapabilities();
  const apiCapability = apiRequestCapability();
  capabilities.push(apiCapability);

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentSkills, agentSkillRequests, skillCapabilities: capabilities });

  // The third-party API sits behind the backend's test-request route, so the mock answers there.
  await page.route("**/backend/api/v1/settings/api-connections**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/backend\/api\/v1/, "");
    if (path === "/settings/api-connections" && request.method() === "GET") {
      return fulfillJson(route, { connections });
    }
    if (path === "/settings/api-connections" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      connectionBodies.push(body);
      const connection: StoredConnection = {
        id: connectionId,
        name: String(body.name),
        baseUrl: String(body.baseUrl),
        authScheme: String(body.authScheme),
        authHeaderName: null,
        credentialMask: "****cret",
        defaultHeaders: {},
        createdAt: stamp,
        updatedAt: stamp,
      };
      connections.push(connection);
      apiCapability.targets = [{ id: connectionId, label: connection.name }];
      apiCapability.available = true;
      apiCapability.unavailableReason = null;
      return fulfillJson(route, { connection }, 201);
    }
    if (path === `/settings/api-connections/${connectionId}/test-request` && request.method() === "POST") {
      testRequests.push(request.postDataJSON());
      return fulfillJson(route, {
        httpStatus: 200,
        durationMs: 42,
        outcome: "completed",
        outputs: { client: longValue },
        mismatches: [],
        bodyTruncated: false,
        body: { order: { status: "shipped", total: 42.5, items: [{ name: "Mug", price: 4.5 }] }, client: longValue },
      });
    }
    return route.fallback();
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();

  // No connection yet: the capability waits on one, and the card leads to where to make it.
  await page.getByRole("button", { name: "Add new skill" }).click();
  await expect(page.getByRole("button", { name: /API request/i })).toBeDisabled();
  await page.getByRole("dialog", { name: "Add new skill" }).getByRole("button", { name: "Manage API connections" }).click();

  const panel = page.getByRole("dialog", { name: "API connections" });
  await panel.getByRole("button", { name: "Add API connection" }).click();
  await panel.getByLabel("Name", { exact: true }).fill("shop-api");
  await panel.getByLabel("Base URL").fill("https://api.shop.example/v2");
  await panel.getByRole("combobox", { name: "Authentication" }).click();
  await page.getByRole("option", { name: "Bearer token" }).click();
  await expect(panel.getByLabel("Header name")).toHaveCount(0);
  await panel.getByLabel("Token").fill("secret-token");
  await panel.getByRole("button", { name: "Create connection" }).click();
  await expect(panel.getByRole("button", { name: "shop-api" })).toBeVisible();
  expect(connectionBodies).toEqual([expect.objectContaining({ name: "shop-api", authScheme: "bearer", credential: "secret-token" })]);
  await page.screenshot({ path: testInfo.outputPath("api-connections.png") });

  // Closing the panel reloads the capabilities, which now have a connection to build on.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /API request/i }).click();
  await expect(page.getByRole("dialog", { name: "Configure API request" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Connection" })).toContainText("shop-api");
  await page.getByLabel("Skill name").fill("order_status");

  await page.getByLabel("Path").fill("/orders/{order_number}");
  await page.getByRole("button", { name: "Input", exact: true }).click();
  await page.getByLabel("Input 1 key").fill("order_number");
  await page.getByLabel("Sample order_number").fill("A-10042");
  await page.getByRole("button", { name: "Send test request" }).click();

  await expect(page.getByLabel("Test request result")).toContainText("completed");
  expect(testRequests).toEqual([expect.objectContaining({
    method: "GET",
    path: "/orders/{order_number}",
    exposedSampleValues: { order_number: "A-10042" },
  })]);

  await page.getByRole("button", { name: "Add order.status as output" }).click();
  await expect(page.getByLabel("Output 1 name")).toHaveValue("status");
  await expect(page.getByLabel("Output 1 path")).toHaveValue("order.status");
  await page.getByRole("button", { name: "Add order.items as output" }).click();
  await expect(page.getByLabel("Output 2 name")).toHaveValue("items");
  await expect(page.getByLabel("Output 2 field 1 path")).toHaveValue("name");
  await page.getByLabel("Test request result").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("api-request-skill-form.png") });

  // The long value stays inside the response tree: the dialog keeps its width, every output
  // row keeps its controls, and Create skill stays in view while the body scrolls.
  const dialogBox = await page.getByRole("dialog", { name: "Configure API request" }).boundingBox();
  const createSkill = page.getByRole("button", { name: "Create skill" });
  for (const control of [
    createSkill,
    page.getByRole("switch", { name: "Output 2 required" }),
    page.getByRole("button", { name: "Add client as output" }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(createSkill).toBeInViewport({ ratio: 1 });
    const box = await control.boundingBox();
    expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0));
  }

  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByText("@order_status", { exact: true })).toBeVisible();

  const created = agentSkillRequests.find((request) => request.method === "POST");
  expect(created?.body).toMatchObject({
    name: "order_status",
    capability: "api_request",
    target: { kind: "api_connection", id: connectionId },
    invocationMode: "routine_named",
    config: {
      method: "GET",
      path: "/orders/{order_number}",
      boundParams: {},
      exposedParams: { order_number: { type: "text", required: true, verifiedOnly: false } },
      outputs: {
        status: { path: "order.status", type: "text", required: false },
        items: {
          path: "order.items",
          type: "list",
          maxItems: 10,
          fields: { name: { path: "name", type: "text" }, price: { path: "price", type: "number" } },
        },
      },
    },
  });
});

test("a connection a skill uses cannot be deleted, and the skills are named", async ({ page }) => {
  const connection: StoredConnection = {
    id: connectionId, name: "shop-api", baseUrl: "https://api.shop.example/v2", authScheme: "none",
    authHeaderName: null, credentialMask: null, defaultHeaders: {}, createdAt: stamp, updatedAt: stamp,
  };

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});
  await page.route("**/backend/api/v1/settings/api-connections**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return fulfillJson(route, { connections: [connection] });
    if (request.method() === "DELETE") {
      return fulfillJson(route, {
        error: {
          code: "api_connection_in_use",
          message: "in use",
          details: { connectionId, references: ["skill:order_status", "skill:order_refund"] },
        },
      }, 409);
    }
    return route.fallback();
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-skills`);
  await page.getByRole("button", { name: "Manage API connections" }).click();
  const panel = page.getByRole("dialog", { name: "API connections" });
  await panel.getByRole("button", { name: "shop-api" }).click();
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete connection" }).click();
  await expect(panel.getByRole("alert")).toContainText("order_status, order_refund");
});

test("a variable set from a list output is only checked for presence", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    routineSkillCatalog: [{
      skillName: "find_orders",
      displayName: "Find orders",
      category: "api_request",
      inputs: [],
      outcomes: [{ name: "completed", displayName: "Completed", status: "completed" }],
      hasDataOutputs: true,
      outputs: [
        { name: "status", type: "text", required: false },
        { name: "orders", type: "list", required: false, fields: [{ name: "title", type: "text", role: "title" }] },
      ],
    }],
  });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await page.getByRole("button", { name: "New routine" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Order lookup");
  const documentEditor = page.getByRole("article", { name: "Routine document editor" });
  await documentEditor.getByRole("button", { name: "Starts when", exact: true }).click();
  await documentEditor.getByLabel("Activation trigger", { exact: true }).fill("a visitor asks about their orders.");
  await documentEditor.getByRole("button", { name: "Done", exact: true }).click();
  await documentEditor.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByRole("menuitem", { name: "Find orders" }).first().click();
  const step = documentEditor.getByRole("button", { name: "Find orders", exact: true }).locator("xpath=ancestor::li[1]");
  await step.getByRole("button", { name: "Find orders", exact: true }).click();
  await step.getByLabel("Step 1 instruction").click();
  await step.getByLabel("Step 1 instruction").pressSequentially("Look up the orders.");
  await step.getByRole("button", { name: "Done", exact: true }).click();

  // The step sets the list into a variable.
  await step.getByRole("button", { name: "Find orders", exact: true }).click();
  await step.getByRole("button", { name: "Edit inputs", exact: true }).click();
  await step.getByRole("button", { name: "Output", exact: true }).click();
  await documentEditor.getByLabel("Output 1 name").selectOption("orders");
  await documentEditor.getByLabel("Output 1 variable").fill("found_orders");
  await step.getByRole("button", { name: "Done", exact: true }).click();

  // A check on that variable offers only is present and is absent.
  await step.getByRole("button", { name: "Find orders", exact: true }).click();
  await step.getByRole("button", { name: "Condition", exact: true }).click();
  await documentEditor.getByLabel("Rule variable").selectOption("found_orders");
  await expect(documentEditor.getByLabel("Rule operator").locator("option")).toHaveText(["is present", "is absent"]);
  // Open the list so the screenshot shows every choice.
  await documentEditor.getByLabel("Rule operator").evaluate((select: HTMLSelectElement) => { select.size = select.options.length; });
  await documentEditor.getByLabel("Rule operator").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("api-request-list-guard.png") });
});
