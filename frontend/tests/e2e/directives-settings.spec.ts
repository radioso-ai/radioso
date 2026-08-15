import { expect, test, type Page } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
  type AgentSkillFixture,
} from "./dashboard-fixtures";

const bindableSkill: AgentSkillFixture = {
  id: "66666666-6666-4666-8666-000000000001",
  workspaceId: "11111111-1111-4111-8111-000000000001",
  agentId: defaultAgentId,
  name: "issue_refund",
  capability: "mcp_tool",
  storedKind: "external_mcp",
  target: { kind: "mcp_tool", id: "tool-1" },
  config: {},
  invocationMode: "agent_selectable",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const openDirectives = async (page: Page) => {
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);
  await expect(page.getByRole("heading", { name: "Directives", level: 1 })).toBeVisible();
};

// The create/edit/delete journey reloads the page three times and drives the Instruction editor a
// keystroke at a time, which runs past the default 30s budget on a loaded machine.
test.describe.configure({ timeout: 60_000 });

// Instruction is a chip-capable editor (typing `#` inserts a skill chip), so it is driven by
// keystrokes rather than a value assignment.
const fillInstruction = async (page: Page, text: string) => {
  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  await instruction.press("ControlOrMeta+a");
  await instruction.press("Backspace");
  await instruction.pressSequentially(text);
  await expect(instruction).toHaveText(text);
};

test("agent directives settings create, edit, delete, and persist", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);

  await expect(page.getByRole("heading", { name: "Directives", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Built-in directives" })).toBeVisible();
  await expect(page.getByText("Read-only")).toHaveCount(3);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("handoff-tone");
  await fillInstruction(page, "When handing off to support, be calm and specific.");
  await page.getByRole("button", { name: "Save directive" }).click();

  // Wait out the dialog close: a directive name also appears as a Replaces option,
  // so the name is only unambiguous once the editor has unmounted.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("handoff-tone")).toBeVisible();
  await expect(page.getByText("No directive conflicts were found.")).toBeVisible();
  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "POST",
    body: {
      name: "handoff-tone",
      condition: { kind: "always" },
      action: "When handing off to support, be calm and specific.",
    },
  });

  await page.reload();
  await expect(page.getByText("handoff-tone")).toBeVisible();

  await page.getByRole("button", { name: "Edit handoff-tone" }).click();
  await page.getByLabel("Name").fill("conflict-tone");
  await fillInstruction(page, "Always be verbose, expansive, and include long explanations.");
  await page.getByRole("button", { name: "Save directive" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("conflict-tone")).toBeVisible();
  await expect(page.getByText("Potential directive conflicts")).toBeVisible();
  await expect(page.getByText("concise-readable-formatting:")).toBeVisible();
  await expect(page.getByText("The saved directive may conflict with a formatting rule.")).toBeVisible();
  await expect.poll(() => directiveUpdates.length).toBe(2);
  expect(directiveUpdates[1]).toMatchObject({
    method: "PATCH",
    body: {
      name: "conflict-tone",
      action: "Always be verbose, expansive, and include long explanations.",
    },
  });

  await page.reload();
  await expect(page.getByText("conflict-tone")).toBeVisible();

  await page.getByRole("button", { name: "Delete conflict-tone" }).click();
  await page.getByRole("button", { name: "Delete directive" }).click();

  await expect(page.locator("#directive-44444444-4444-4444-8444-000000000001")).toBeHidden();
  await expect.poll(() => directiveUpdates.length).toBe(3);
  expect(directiveUpdates[2]).toMatchObject({ method: "DELETE" });

  await page.reload();
  await expect(page.locator("#directive-44444444-4444-4444-8444-000000000001")).toBeHidden();
});

test("agent directives settings can replace and restore a built-in directive", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);

  // The Override button is a shortcut into the normal create dialog with the
  // built-in pre-selected in Replaces, the priority field exposed, everything editable.
  await page.getByRole("button", { name: "Replace inline-supported-links for this agent" }).click();
  await expect(page.getByRole("heading", { name: "New directive" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Override: inline-supported-links");
  // The preselection reads back as a pill, without opening the candidate picker.
  await expect(page.getByRole("button", { name: "Stop replacing inline-supported-links" })).toBeVisible();
  await page.getByRole("radio", { name: /In a specific situation/ }).click();
  await page.getByLabel("Situation").fill("answering legal policy questions");
  await fillInstruction(page, "Use the agent's legal-source link policy instead of the default link style.");
  await page.getByLabel("Priority").fill("95");
  await page.getByRole("button", { name: "Save directive" }).click();

  // The override is contextual, so the built-in is only superseded when the
  // condition fires — the UI must say so instead of implying a permanent replace.
  await expect(page.getByText("Replaced by Override: inline-supported-links")).toBeVisible();
  await expect(
    page.getByText("only when: answering legal policy questions", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Replaces inline-supported-links when active")).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace inline-supported-links for this agent" })).toHaveCount(0);
  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "POST",
    body: {
      name: "Override: inline-supported-links",
      condition: { kind: "contextual", description: "answering legal policy questions" },
      action: "Use the agent's legal-source link policy instead of the default link style.",
      excludes: ["inline-supported-links"],
      priority: 95,
    },
  });

  await page.getByRole("button", { name: "Delete Override: inline-supported-links" }).click();
  await page.getByRole("button", { name: "Delete directive" }).click();

  await expect(page.getByText("Replaced by Override: inline-supported-links")).toBeHidden();
  await expect(page.getByText("Replaces inline-supported-links when active")).toBeHidden();
  await expect(page.getByRole("button", { name: "Replace inline-supported-links for this agent" })).toBeVisible();
  await expect.poll(() => directiveUpdates.length).toBe(2);
  expect(directiveUpdates[1]).toMatchObject({ method: "DELETE" });
});

test("agent directives settings can resolve a conflict by superseding another directive", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("brief-tone");
  await fillInstruction(page, "Keep replies short and direct.");
  await page.getByRole("button", { name: "Save directive" }).click();

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("conflict-tone");
  await fillInstruction(page, "Always be verbose, expansive, and include long explanations.");
  await page.getByRole("button", { name: "Save directive" }).click();

  await expect(page.getByText("Potential directive conflicts")).toBeVisible();
  await expect(page.getByRole("button", { name: "conflict-tone supersedes brief-tone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "brief-tone supersedes conflict-tone" })).toBeVisible();

  await page.getByRole("button", { name: "conflict-tone supersedes brief-tone" }).click();

  await expect(page.getByText("Replaces: brief-tone")).toBeVisible();
  await expect(page.getByText("No directive conflicts were found.")).toBeVisible();
  await expect.poll(() => directiveUpdates.length).toBe(3);
  expect(directiveUpdates[2]).toMatchObject({
    method: "PATCH",
    body: {
      name: "conflict-tone",
      excludes: ["brief-tone"],
    },
  });
});

test("agent directives settings can open a conflicting directive as contextual", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-directives`);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("brief-tone");
  await fillInstruction(page, "Keep replies short and direct.");
  await page.getByRole("button", { name: "Save directive" }).click();

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("conflict-tone");
  await fillInstruction(page, "Always be verbose, expansive, and include long explanations.");
  await page.getByRole("button", { name: "Save directive" }).click();

  await page.getByRole("button", { name: "Make conflict-tone apply only conditionally" }).click();

  await expect(page.getByRole("heading", { name: "Edit directive" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("conflict-tone");
  await expect(page.getByRole("radio", { name: /In a specific situation/ })).toBeChecked();
  await expect(page.getByLabel("Situation")).toBeVisible();
});

test("agent directives bind a skill by inserting a chip in the action", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [
      bindableSkill,
      { ...bindableSkill, id: "66666666-6666-4666-8666-000000000002", name: "routine_only_skill", invocationMode: "routine_named" },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("refund-handoff");

  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  await instruction.pressSequentially("Refund the order using #");

  // Only skills the API will accept as a binding are offered.
  await expect(page.getByText("issue_refund").first()).toBeVisible();
  await expect(page.getByText("routine_only_skill")).toHaveCount(0);
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]?.body).toMatchObject({
    action: "Refund the order using #issue_refund",
    binding: { kind: "skill", skillName: "issue_refund" },
  });
});

test("agent directives browse bindable skills from the action field", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [
      bindableSkill,
      { ...bindableSkill, id: "66666666-6666-4666-8666-000000000002", name: "routine_only_skill", invocationMode: "routine_named" },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("refund-handoff");
  await fillInstruction(page, "Refund the order using ");

  await page.getByRole("button", { name: "Browse skills" }).click();
  await expect(page.getByRole("menuitem", { name: /issue_refund/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /routine_only_skill/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /issue_refund/ }).click();

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]?.body).toMatchObject({
    action: "Refund the order using #issue_refund",
    binding: { kind: "skill", skillName: "issue_refund" },
  });
});

test("agent directives explain when no skills qualify in both skill menus", async ({ page }) => {
  const noQualifyingSkills = "No skill can answer a turn yet. A directive can draw on an MCP tool, or a knowledge lookup the agent is allowed to pick.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentSkills: [] });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByRole("button", { name: "Browse skills" }).click();
  await expect(page.getByRole("menuitem", { name: noQualifyingSkills })).toBeVisible();
  await page.keyboard.press("Escape");

  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  await instruction.pressSequentially("#");
  await expect(page.getByRole("option", { name: noQualifyingSkills })).toBeVisible();

  // Typing a name puts an actionable option on offer, so the notice steps aside rather than
  // sitting where the menu's first-option highlight is.
  await instruction.pressSequentially("RefundLookup");
  await expect(page.getByRole("option", { name: 'Create skill “RefundLookup”' })).toBeVisible();
  await expect(page.getByRole("option", { name: noQualifyingSkills })).toHaveCount(0);
});

test("agent directives reach inline skill creation from the keyboard", async ({ page }) => {
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentSkillRequests, agentSkills: [] });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("refund-handoff");

  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  // Paced typing: under parallel-worker CPU contention Lexical's typeahead can
  // record a stale replacement range for the # query, leaving partial "#Ref"
  // text behind after the menu inserts the chip.
  await instruction.pressSequentially("Refund the order using #RefundLookup", { delay: 20 });
  await expect(page.getByRole("option", { name: 'Create skill “RefundLookup”' })).toBeVisible();

  // Enter takes the menu's highlighted option. An empty catalog must not park a dead notice
  // there, or the keyboard path closes the menu and creation never starts.
  await page.keyboard.press("Enter");

  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeVisible();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();
  await expect(page.getByLabel("Skill name")).toHaveValue("refundlookup");
  await page.getByRole("button", { name: "Create skill", exact: true }).click();

  // The retrieve skill form carries its own "Instruction" setting, so the directive's field is
  // only unambiguous once that dialog has gone.
  await expect(page.getByRole("dialog", { name: /Configure Knowledge Retrieval/ })).toBeHidden();
  await expect(instruction).toHaveText("Refund the order using refundlookup");
  await expect.poll(() => agentSkillRequests.length).toBe(1);
});

test("agent directives author a skill from the browse menu without typing a name", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates, agentSkillRequests, agentSkills: [] });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("event-lookup");
  await fillInstruction(page, "Answer from the events calendar ");

  // An empty catalog is a starting point, not a dead end: the browse menu can author one.
  await page.getByRole("button", { name: "Browse skills" }).click();
  await page.getByRole("menuitem", { name: "Add a new skill..." }).click();

  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeVisible();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();
  // Nothing was typed, so the form seeds its own suggested name rather than an empty one.
  await expect(page.getByLabel("Skill name")).not.toHaveValue("");
  const createdName = await page.getByLabel("Skill name").inputValue();
  await page.getByRole("button", { name: "Create skill", exact: true }).click();

  await expect(page.getByRole("dialog", { name: /Configure Knowledge Retrieval/ })).toBeHidden();

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => agentSkillRequests.length).toBe(1);
  expect(agentSkillRequests[0]).toMatchObject({
    method: "POST",
    body: { name: createdName, capability: "retrieve", invocationMode: "agent_selectable", enabled: true },
  });

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]?.body).toMatchObject({
    binding: { kind: "skill", skillName: createdName },
  });
});

// Refusing without a destination is a dead end: these four capabilities are how routine steps act,
// so the directive picker has to name that surface rather than only say no.
test("agent directives point acting capabilities at routine steps", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { agentSkills: [] });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  await instruction.pressSequentially("#refund_lookup");
  await page.getByRole("option", { name: 'Create skill “refund_lookup”' }).click();

  const capabilityDialog = page.getByRole("dialog", { name: "Add new skill" });
  await expect(capabilityDialog).toBeVisible();
  for (const capability of ["Email", "Slack Post", "Webhook Call", "Notify Human"]) {
    await expect(capabilityDialog.getByRole("button", { name: new RegExp(capability) })).toBeDisabled();
  }
  await expect(
    capabilityDialog.getByText("Acts instead of replying. Use it in a routine step.", { exact: true }),
  ).toHaveCount(4);
  await expect(capabilityDialog.getByText("Not available for directives.", { exact: true })).toHaveCount(0);
});

test("agent directives create a skill inline from the action field and bind it", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates, agentSkillRequests, agentSkills: [] });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("refund-handoff");

  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  // A name the agent has no skill for used to dead-end; now it offers to author one.
  await instruction.pressSequentially("Refund the order using #RefundLookup");
  await page.getByRole("option", { name: 'Create skill “RefundLookup”' }).click();

  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeVisible();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();

  // The typed name is a skill name only after normalization, so the form shows what will exist.
  await expect(page.getByLabel("Skill name")).toHaveValue("refundlookup");
  await page.getByRole("button", { name: "Create skill", exact: true }).click();

  await expect(page.getByRole("dialog", { name: /Configure Knowledge Retrieval/ })).toBeHidden();
  await expect(instruction).toHaveText("Refund the order using refundlookup");
  await expect(page.getByText(/is available to bind/)).toHaveCount(0);

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => agentSkillRequests.length).toBe(1);
  expect(agentSkillRequests[0]).toMatchObject({
    method: "POST",
    path: `/agents/${defaultAgentId}/skills`,
    // Authored for a binding, so it is created bindable rather than with the form's
    // routine-oriented defaults.
    body: { name: "refundlookup", capability: "retrieve", invocationMode: "agent_selectable", enabled: true },
  });

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]?.body).toMatchObject({
    action: "Refund the order using #refundlookup",
    binding: { kind: "skill", skillName: "refundlookup" },
  });
});

test("agent directives leave no chip when inline skill creation is abandoned", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  const agentSkillRequests: Array<{ method: string; path: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates, agentSkillRequests, agentSkills: [] });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByLabel("Name").fill("refund-handoff");

  const instruction = page.getByLabel("Instruction");
  await instruction.click();
  await instruction.pressSequentially("Refund the order using #refund_lookup");
  await page.getByRole("option", { name: 'Create skill “refund_lookup”' }).click();

  // Backing out at the capability step, on a dialog stacked over the directive dialog.
  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Add new skill" })).toBeHidden();
  // The trigger text went with the menu, so the field holds prose and no binding.
  await expect(instruction).toHaveText("Refund the order using");

  // And backing out one dialog deeper, from the skill form itself.
  await instruction.click();
  await instruction.pressSequentially(" #refund_lookup");
  await page.getByRole("option", { name: 'Create skill “refund_lookup”' }).click();
  await page.getByRole("button", { name: /Knowledge Retrieval/i }).click();
  await expect(page.getByLabel("Skill name")).toHaveValue("refund_lookup");
  await page.getByRole("button", { name: "Cancel" }).last().click();

  await expect(page.getByRole("dialog", { name: /Configure Knowledge Retrieval/ })).toBeHidden();
  await expect(instruction).toHaveText("Refund the order using");

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  expect(agentSkillRequests).toHaveLength(0);
  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]?.body).toMatchObject({
    action: "Refund the order using",
    binding: null,
  });
});

test("agent directives keep a prose #word out of the binding", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  const proseAction = "Point the customer at #policy for the refund window.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [bindableSkill],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000002",
        name: "policy-pointer",
        condition: { kind: "always" },
        // The grammar reads `#word` as a skill wherever it appears, but this directive's binding
        // is null, so the word is prose the author wrote and nothing else.
        action: proseAction,
        binding: null,
        priority: 50,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit policy-pointer" }).click();
  // Text, not a chip: a chip renders its bare name, prose keeps the `#`.
  await expect(page.getByLabel("Instruction")).toHaveText(proseAction);
  await expect(page.getByText(/is available to bind/)).toHaveCount(0);

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "PATCH",
    body: { action: proseAction, binding: null },
  });
});

test("agent directives keep a prose #word out of the binding even when a skill has that name", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  const proseAction = "Point the customer at #billing for pricing questions.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    // A real, bindable skill by that name — the case where seeding a chip from the prose would
    // have produced a binding that saves cleanly and that nobody authored.
    agentSkills: [{ ...bindableSkill, name: "billing" }],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000003",
        name: "policy-pointer",
        condition: { kind: "always" },
        action: proseAction,
        binding: null,
        priority: 60,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit policy-pointer" }).click();
  await expect(page.getByLabel("Instruction")).toHaveText(proseAction);

  // Edit something unrelated: the binding must not arrive as a side effect of saving.
  await page.getByLabel("Priority").fill("70");
  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "PATCH",
    body: { action: proseAction, binding: null, priority: 70 },
  });
});

test("agent directives refuse a binding whose skill has been disabled", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [{ ...bindableSkill, enabled: false }],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000001",
        name: "refund-handoff",
        condition: { kind: "always" },
        action: "Refund the order using #issue_refund",
        binding: { kind: "skill", skillName: "issue_refund" },
        priority: 50,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  await expect(page.getByText(/No skill named issue_refund is available to bind/)).toBeVisible();
  // Save stays clickable and simply refuses: a dead button would state no reason of its own.
  const save = page.getByRole("button", { name: "Save directive" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(directiveUpdates).toHaveLength(0);
});

test("agent directives reopen and resave a bound action that ends a sentence", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  // Authors put the chip where the sentence needs it, which is often last. The action is the
  // instruction the model reads, so opening a directive and saving it must return the stored
  // characters — a period that joined the skill name would hide the chip and let the section
  // append a second `#issue_refund` on a save the operator sees as a priority change.
  const boundAction = "Escalate using #issue_refund.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [bindableSkill],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000004",
        name: "refund-handoff",
        condition: { kind: "always" },
        action: boundAction,
        binding: { kind: "skill", skillName: "issue_refund" },
        priority: 50,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  // A chip renders its bare name; the period stayed in the prose beside it.
  await expect(page.getByLabel("Instruction")).toHaveText("Escalate using issue_refund.");
  await expect(page.getByText(/is available to bind/)).toHaveCount(0);

  await page.getByLabel("Priority").fill("70");
  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "PATCH",
    body: { action: boundAction, binding: { kind: "skill", skillName: "issue_refund" }, priority: 70 },
  });
});

// `#issue_refund-tier2` names a different skill: `-` extends an identifier, so nothing here is a
// mention of `issue_refund`. When the section read that token as the binding it skipped appending
// the real mention, the editor seeded no chip for it, and the mount emit reported an empty chip
// list — so opening the directive and saving it untouched cleared the binding. The two readers of
// the action text now agree, so the binding survives.
test("agent directives keep a binding when the action names a longer skill", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  const storedAction = "Escalate tier-two refunds with #issue_refund-tier2.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [bindableSkill],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000006",
        name: "refund-handoff",
        condition: { kind: "always" },
        action: storedAction,
        binding: { kind: "skill", skillName: "issue_refund" },
        priority: 50,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  // The stored characters are untouched and the bound skill is now visible as a chip the author
  // can remove, rather than an invisible rule that a no-op save would drop.
  await expect(page.getByLabel("Instruction")).toHaveText(`${storedAction} issue_refund`);

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "PATCH",
    body: {
      action: `${storedAction} #issue_refund`,
      binding: { kind: "skill", skillName: "issue_refund" },
    },
  });
});

test("agent directives resave an action naming both its bound skill and a longer one", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  // The mention is already written, so a save with no edits is a no-op down to the byte: nothing to
  // append, and the longer name beside it stays the prose the author wrote.
  const storedAction = "Try #issue_refund-tier2, then fall back to #issue_refund.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [bindableSkill],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000007",
        name: "refund-handoff",
        condition: { kind: "always" },
        action: storedAction,
        binding: { kind: "skill", skillName: "issue_refund" },
        priority: 50,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  await expect(page.getByLabel("Instruction")).toHaveText("Try #issue_refund-tier2, then fall back to issue_refund.");

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "PATCH",
    body: { action: storedAction, binding: { kind: "skill", skillName: "issue_refund" } },
  });
});

test("agent directives save an action that names its bound skill twice", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];
  // Two chips, one skill: the sentence says the name twice and means it once, so there is nothing
  // ambiguous to refuse and no reason to make the operator reword a directive that already works.
  const repeatedAction = "Use #issue_refund, and if that fails use #issue_refund again.";

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directiveUpdates,
    agentSkills: [bindableSkill],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000005",
        name: "refund-handoff",
        condition: { kind: "always" },
        action: repeatedAction,
        binding: { kind: "skill", skillName: "issue_refund" },
        priority: 50,
        excludes: [],
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  await expect(page.getByText(/hand off to one skill/)).toHaveCount(0);

  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]).toMatchObject({
    method: "PATCH",
    body: { action: repeatedAction, binding: { kind: "skill", skillName: "issue_refund" } },
  });
});

test("agent directives validate a binding again after the skills list fails to load", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    agentSkills: [{ ...bindableSkill, enabled: false }],
    directives: [
      {
        id: "77777777-7777-4777-8777-000000000006",
        name: "refund-handoff",
        condition: { kind: "always" },
        action: "Refund the order using #issue_refund",
        binding: { kind: "skill", skillName: "issue_refund" },
        priority: 50,
        excludes: [],
      },
    ],
  });

  // Registered after the dashboard mocks, so it wins and can hand the request back to them.
  let failSkillList = true;
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/skills(\\?|$)`), async (route) => {
    if (route.request().method() === "GET" && failSkillList) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
      return;
    }
    await route.fallback();
  });

  await openDirectives(page);

  // A load that has not landed says nothing about this binding, so the directive stays saveable.
  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  await expect(page.getByRole("button", { name: "Save directive" })).toBeEnabled();
  await expect(page.getByText(/is available to bind/)).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // One bad request must not disable validation for the session: reopening asks again.
  failSkillList = false;
  await page.getByRole("button", { name: "Edit refund-handoff" }).click();
  await expect(page.getByText(/No skill named issue_refund is available to bind/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save directive" })).toBeEnabled();
});

// An agent accumulates directives, so the candidate list has to stay usable well past the handful
// a fresh agent has.
test("agent directives filter the replaces candidates down to one", async ({ page }) => {
  const manyDirectives = Array.from({ length: 12 }, (_, index) => ({
    id: `88888888-8888-4888-8888-0000000000${String(index + 10)}`,
    name: `escalation-tone-${index + 1}`,
    condition: { kind: "always" } as const,
    action: "Escalate calmly.",
  }));

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    directives: [
      ...manyDirectives,
      {
        id: "88888888-8888-4888-8888-000000000099",
        name: "late-window-note",
        condition: { kind: "always" },
        action: "Explain the policy.",
        description: "How to answer refund questions after the window closes.",
      },
    ],
  });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();
  await page.getByRole("button", { name: "Choose directives" }).click();

  await expect(page.getByText("Built-in behaviors")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Replace escalation-tone-1", exact: true })).toBeVisible();

  // Matching runs over name and description, so a directive can be found by what it does.
  await page.getByLabel("Filter directives").fill("refund");
  await expect(page.getByRole("checkbox", { name: "Replace late-window-note" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Replace escalation-tone-1", exact: true })).toHaveCount(0);
  await expect(page.getByText("Built-in behaviors")).toHaveCount(0);

  await page.getByLabel("Filter directives").fill("nothing-matches-this");
  await expect(page.getByText('No directives match "nothing-matches-this".')).toBeVisible();

  await page.getByLabel("Filter directives").fill("refund");
  await page.getByRole("checkbox", { name: "Replace late-window-note" }).click();
  await expect(page.getByRole("button", { name: "Stop replacing late-window-note" })).toBeVisible();
});

test("agent directives drop a selected replacement from its pill", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });
  await openDirectives(page);

  // The Override shortcut preselects the built-in, so this starts from a selection nobody typed.
  await page.getByRole("button", { name: "Replace inline-supported-links for this agent" }).click();
  await page.getByRole("button", { name: "Stop replacing inline-supported-links" }).click();

  await expect(page.getByRole("button", { name: "Stop replacing inline-supported-links" })).toHaveCount(0);
  await expect(page.getByText("Nothing yet — this directive applies alongside the others.")).toBeVisible();

  await fillInstruction(page, "Link to sources the way the agent normally does.");
  await page.getByRole("button", { name: "Save directive" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await expect.poll(() => directiveUpdates.length).toBe(1);
  expect(directiveUpdates[0]?.body).not.toHaveProperty("excludes");
});

test("agent directives stay quiet until the operator asks to save", async ({ page }) => {
  const directiveUpdates: Array<{ method: "POST" | "PATCH" | "DELETE"; directiveId?: string; body?: unknown }> = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { directiveUpdates });
  await openDirectives(page);

  await page.getByRole("button", { name: "New directive" }).click();

  // Nothing has been written, so there is nothing to report yet.
  await expect(page.getByText("Name is required.")).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save directive" });
  await expect(save).toBeEnabled();

  await save.click();
  await expect(page.getByText("Name is required.")).toBeVisible();
  expect(directiveUpdates).toHaveLength(0);

  await page.getByLabel("Name").fill("handoff-tone");
  await expect(page.getByText("Name is required.")).toHaveCount(0);
  await expect(page.getByText("Instruction is required.")).toBeVisible();

  await fillInstruction(page, "Hand off calmly and say what happens next.");
  await expect(page.getByText("Instruction is required.")).toHaveCount(0);

  await save.click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(() => directiveUpdates.length).toBe(1);
});
