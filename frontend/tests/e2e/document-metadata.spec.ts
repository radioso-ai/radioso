import { expect, test } from "@playwright/test";

import {
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const existingDocument = {
  id: "doc-existing",
  title: "Existing Doc",
  status: "ready",
  ragStatus: "processed",
  createdAt: nowIso,
  updatedAt: nowIso,
  metadata: {},
  sourceKind: "inline_text" as const,
  retrievalEnabled: true,
  retrievalExpiresAt: null,
};

const createdDocument = {
  ...existingDocument,
  id: "doc-created",
  title: "Course Guide",
  metadata: { region: "emea", capacity: 42 },
  content: "Course body",
};

const documentsPath = "/backend/api/v1/document/";
const importPath = "/backend/api/v1/document/import";

/**
 * Pulls one field out of a captured multipart body. The import route is the only
 * documents endpoint that is not JSON, so its assertions read the raw form.
 */
const multipartField = (body: string, name: string): string | null => {
  const match = body.match(new RegExp(`name="${name}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`));
  return match ? match[1] : null;
};

test("operator adds document tags while writing a document, and the saved document shows them", async ({
  page,
}) => {
  const createRequests: Array<Record<string, unknown>> = [];
  let created = false;

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [existingDocument],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    documentDetails: { [createdDocument.id]: createdDocument },
  });

  // Registered after the shared mocks so it wins for the documents collection,
  // which the fixture only serves as a static list.
  await page.route(
    (url) => url.pathname === documentsPath,
    async (route) => {
      const request = route.request();

      if (request.method() === "POST") {
        createRequests.push(request.postDataJSON() as Record<string, unknown>);
        created = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ documentId: createdDocument.id, status: "queued" }),
        });
        return;
      }

      if (request.method() !== "GET") {
        await route.fallback();
        return;
      }

      const documents = created ? [existingDocument, createdDocument] : [existingDocument];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents,
          total: documents.length,
          nextCursor: null,
          hasMore: false,
        }),
      });
    },
  );

  await page.goto(`/w/${workspaceKey}/knowledge`);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Write document" }).click();

  await page.getByLabel("Title").fill("Course Guide");
  await page.getByLabel("Content").fill("Course body");

  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByLabel("Metadata key 1").fill("region");
  await page.getByLabel("Metadata value 1").fill("emea");

  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByRole("combobox", { name: "Metadata value type 2" }).click();
  await page.getByRole("option", { name: "Number" }).click();
  await page.getByLabel("Metadata key 2").fill("capacity");
  await page.getByLabel("Metadata value 2").fill("42");

  await page.getByRole("button", { name: "Add Document" }).click();

  // Tags reach the create request as native JSON scalars, not as text.
  await expect.poll(() => createRequests.length).toBeGreaterThanOrEqual(1);
  expect(createRequests.at(-1)).toMatchObject({
    title: "Course Guide",
    metadata: { region: "emea", capacity: 42 },
  });

  // The saved document carries them, shown as badges rather than editable rows.
  await page.getByRole("button", { name: "Course Guide", exact: true }).click();
  await page.getByRole("button", { name: "Properties" }).click();
  await expect(page.getByText("region: emea")).toBeVisible();
  await expect(page.getByText("capacity: 42")).toBeVisible();
});

test("operator blocks a save while two document tags share a key", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [existingDocument],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Write document" }).click();

  await page.getByLabel("Title").fill("Course Guide");
  await page.getByLabel("Content").fill("Course body");

  const submit = page.getByRole("button", { name: "Add Document" });
  await expect(submit).toBeEnabled();

  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByLabel("Metadata key 1").fill("region");
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByLabel("Metadata key 2").fill("region");

  await expect(submit).toBeDisabled();

  // Resolving the collision releases the save again.
  await page.getByLabel("Metadata key 2").fill("department");
  await expect(submit).toBeEnabled();
});

test("operator sets document tags while importing a file", async ({ page }) => {
  const importBodies: string[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [existingDocument],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
  });

  await page.route(
    (url) => url.pathname === importPath,
    async (route) => {
      importBodies.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ documentId: "doc-imported", status: "queued" }),
      });
    },
  );

  await page.goto(`/w/${workspaceKey}/knowledge`);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import file" }).click();

  await page.getByLabel("File").setInputFiles({
    name: "guide.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Course guide"),
  });
  await page.getByLabel("Title override (optional)").fill("Course Guide");

  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByLabel("Metadata key 1").fill("region");
  await page.getByLabel("Metadata value 1").fill("emea");

  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByRole("combobox", { name: "Metadata value type 2" }).click();
  await page.getByRole("option", { name: "True/false" }).click();
  await page.getByLabel("Metadata key 2").fill("archived");

  await page.getByRole("button", { name: "Import Document" }).click();

  await expect.poll(() => importBodies.length).toBeGreaterThanOrEqual(1);
  const body = importBodies.at(-1) ?? "";
  expect(multipartField(body, "title")).toBe("Course Guide");
  expect(JSON.parse(multipartField(body, "metadata") ?? "null")).toMatchObject({
    region: "emea",
    archived: false,
  });
});

const importedDocument = {
  ...existingDocument,
  id: "doc-imported-file",
  title: "Imported Handbook",
  metadata: { audience: "operators" },
  sourceKind: "uploaded_file" as const,
  sourceFilename: "handbook.pdf",
  sourceMimeType: "application/pdf",
  content: "Extracted handbook body",
};

// Imported files cannot be edited through the inline document API, so their tags
// save on their own through the document PATCH while the contents stay read-only.
test("operator retags an imported document without gaining access to its contents", async ({
  page,
}) => {
  const patchBodies: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentList: {
      documents: [importedDocument],
      total: 1,
      nextCursor: null,
      hasMore: false,
    },
    documentDetails: { [importedDocument.id]: importedDocument },
  });

  await page.route(
    (url) => url.pathname === `${documentsPath}${importedDocument.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback();
        return;
      }
      patchBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...importedDocument,
          metadata: { audience: "admins", priority: 2 },
          status: "queued",
        }),
      });
    },
  );

  await page.goto(`/w/${workspaceKey}/knowledge`);
  await page.getByRole("button", { name: importedDocument.title, exact: true }).click();
  await page.getByRole("button", { name: "Properties" }).click();

  // The contents stay read-only: editing the document is offered but refused.
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();

  // The stored tags seed the editor, and they remain editable.
  const audienceValue = page.getByLabel("Metadata value 1");
  await expect(page.getByLabel("Metadata key 1")).toHaveValue("audience");
  await expect(audienceValue).toHaveValue("operators");

  await audienceValue.fill("admins");
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.getByRole("combobox", { name: "Metadata value type 2" }).click();
  await page.getByRole("option", { name: "Number" }).click();
  await page.getByLabel("Metadata key 2").fill("priority");
  await page.getByLabel("Metadata value 2").fill("2");

  await page.getByRole("button", { name: "Save metadata" }).click();

  await expect.poll(() => patchBodies.length).toBeGreaterThanOrEqual(1);
  expect(patchBodies.at(-1)).toEqual({
    metadata: { audience: "admins", priority: 2 },
  });
});
