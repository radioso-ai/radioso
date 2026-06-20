import { expect, test } from "@playwright/test";

import {
  defaultAgentId,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

// The prose chips used to vanish when copied to an external app (their clipboard text was
// empty). This proves the whole routine — header, variable chip, and end target — survives
// a copy to the clipboard ("the external file") and a paste back from text alone.
test("routine prose survives a copy to an external file and back", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Greeter");
  await page.getByLabel("Trigger", { exact: true }).fill("When the user says thanks");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Record their name as ");
  await editor.pressSequentially("@guest_name");
  await page.getByRole("option", { name: /Create variable/ }).click();
  await editor.pressSequentially("then wrap up ");
  await page.getByRole("button", { name: "End" }).click();

  await expect(page.locator('[data-routine-chip="variable"]')).toBeVisible();
  await expect(page.locator('[data-routine-chip="end"]')).toBeVisible();

  // Copy the whole routine as portable text.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("name: Greeter");
  expect(copied).toContain("@guest_name");
  expect(copied).toContain("-> end");

  // Wipe the editor body and the name, the way pasting into a fresh routine would start.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.getByLabel("Name", { exact: true }).fill("");
  await expect(page.locator('[data-routine-chip="variable"]')).toHaveCount(0);

  // Paste it back — the chips and header are reconstructed from the text alone.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+v");

  await expect(page.locator('[data-routine-chip="variable"]')).toBeVisible();
  await expect(page.locator('[data-routine-chip="end"]')).toBeVisible();
  await expect(editor).toContainText("@guest_name");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Greeter");
});

// A pasted document replaces the routine only when it carries our routine frontmatter. A
// foreign markdown doc that merely opens with `---` and happens to contain an @mention must
// be inserted, never wipe the routine the author is editing.
test("pasting a foreign document that opens with --- does not wipe the routine", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {});

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-routines`);
  await expect(page.getByRole("heading", { name: "Routines", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Write in prose" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Greeter");

  const editor = page.getByRole("textbox", { name: "Routine", exact: true });
  await editor.click();
  await editor.pressSequentially("Keep this routine intact.");

  // A markdown note with YAML frontmatter (not ours) plus an @mention — looks like prose,
  // but is not a routine.
  await page.evaluate(() =>
    navigator.clipboard.writeText("---\ntitle: Notes\ntags: x\n---\nPing @world about the launch."),
  );
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+v");

  // The original line is still there (the routine was not replaced); the foreign text was
  // inserted at the caret, and its @mention became a variable chip.
  await expect(editor).toContainText("Keep this routine intact.");
  await expect(editor).toContainText("@world");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Greeter");
});
