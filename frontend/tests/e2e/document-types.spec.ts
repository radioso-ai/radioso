import { expect, test } from "@playwright/test";

import {
  baseDocumentTypeCatalog,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from "./dashboard-fixtures";

const catalogWithProduct = () => {
  const catalog = baseDocumentTypeCatalog();
  return {
    ...catalog,
    revision: "4",
    types: [
      ...catalog.types,
      {
        key: "product",
        label: "Product",
        description: "A product detail page.",
        enabled: true,
        origin: "operator" as const,
        payload: "fields" as const,
        disableable: true,
        fields: [
          { key: "price", label: "Price", valueType: "number" as const, instruction: "The listed price." },
          { key: "category", label: "Category", valueType: "string" as const, instruction: "The category." },
        ],
      },
    ],
  };
};

test("operator defines a Product type with fields and saves the whole catalog", async ({ page }) => {
  const documentTypeCatalogUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { documentTypeCatalogUpdates });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=ingestion`);

  const catalog = page.getByTestId("document-type-catalog");
  await expect(catalog).toBeVisible();

  await catalog.getByRole("button", { name: "Add document type" }).click();

  const type = catalog.getByTestId("operator-type");
  await type.getByLabel("Label", { exact: true }).fill("Product");
  await type.getByLabel("Key", { exact: true }).fill("product");
  await type.getByLabel("What this kind of page looks like").fill("A product detail page: one purchasable item, with a price.");

  await type.getByRole("button", { name: "Add field" }).click();
  const field = catalog.getByTestId("operator-type-field");
  await field.getByLabel("Key", { exact: true }).fill("price");
  await field.getByLabel("Label", { exact: true }).fill("Price");
  await field.getByRole("combobox", { name: "Value type for price" }).click();
  await page.getByRole("option", { name: "Number" }).click();
  await field.getByLabel("What to extract").fill("The listed price as a number.");

  await catalog.getByRole("button", { name: "Save document types" }).click();

  await expect.poll(() => documentTypeCatalogUpdates.length).toBeGreaterThanOrEqual(1);
  expect(documentTypeCatalogUpdates.at(-1)).toEqual({
    expectedRevision: "1",
    types: [
      {
        key: "product",
        label: "Product",
        description: "A product detail page: one purchasable item, with a price.",
        enabled: true,
        fields: [
          { key: "price", label: "Price", valueType: "number", instruction: "The listed price as a number." },
        ],
      },
    ],
    disabledBuiltInTypeKeys: [],
  });

  // After the save the key and value type are settled, so both inputs lock.
  await expect(catalog.getByTestId("operator-type-field").getByLabel("Key", { exact: true })).toBeDisabled();
});

test("built-in types are read-only and the generic fallback cannot be turned off", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page);

  await page.goto(`/w/${workspaceKey}/knowledge?tab=ingestion`);

  const catalog = page.getByTestId("document-type-catalog");
  const event = catalog.getByTestId("built-in-type-event");
  await expect(event.getByText("Event", { exact: true })).toBeVisible();
  await expect(event.getByText("dateFrom · Date")).toBeVisible();
  await expect(event.getByRole("switch", { name: "Classify documents as Event" })).toBeVisible();

  const generic = catalog.getByTestId("built-in-type-generic");
  await expect(generic.getByText("Always on — the fallback")).toBeVisible();
  await expect(generic.getByRole("switch")).toHaveCount(0);
});

test("turning off a built-in type is sent as a disabled key", async ({ page }) => {
  const documentTypeCatalogUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, { documentTypeCatalogUpdates });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=ingestion`);

  const catalog = page.getByTestId("document-type-catalog");
  await catalog.getByRole("switch", { name: "Classify documents as Profile" }).click();
  await catalog.getByRole("button", { name: "Save document types" }).click();

  await expect.poll(() => documentTypeCatalogUpdates.length).toBeGreaterThanOrEqual(1);
  expect(documentTypeCatalogUpdates.at(-1)).toMatchObject({
    expectedRevision: "1",
    disabledBuiltInTypeKeys: ["profile"],
  });
});

test("a stale revision is reported rather than overwriting the other save", async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentTypeCatalog: catalogWithProduct(),
    documentTypeCatalogStaleRevision: true,
  });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=ingestion`);

  const catalog = page.getByTestId("document-type-catalog");
  // The type's own Label input comes before its fields' Label inputs.
  const typeLabel = catalog.getByTestId("operator-type").getByLabel("Label", { exact: true }).first();
  await typeLabel.fill("Products");
  await catalog.getByRole("button", { name: "Save document types" }).click();

  await expect(catalog.getByRole("alert")).toContainText("Someone else saved this catalog");
  // The refetched catalog replaces the draft, so the operator reapplies onto the current revision.
  await expect(typeLabel).toHaveValue("Product");
});

test("deleting a field an agent rule references warns before the save goes through", async ({ page }) => {
  const documentTypeCatalogUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentTypeCatalog: { ...catalogWithProduct(), referencedFieldKeys: ["category"] },
    documentTypeCatalogUpdates,
  });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=ingestion`);

  const catalog = page.getByTestId("document-type-catalog");
  await catalog.getByRole("button", { name: "Delete field category" }).click();

  const deleteDialog = page.getByRole("alertdialog", { name: "Delete this field?" });
  await expect(deleteDialog).toContainText("retired");
  await deleteDialog.getByRole("button", { name: "Delete" }).click();

  await catalog.getByRole("button", { name: "Save document types" }).click();

  const advisory = page.getByRole("alertdialog", { name: "Agent rules point at these fields" });
  await expect(advisory).toContainText("category");
  expect(documentTypeCatalogUpdates).toHaveLength(0);

  await advisory.getByRole("button", { name: "Save anyway" }).click();

  await expect.poll(() => documentTypeCatalogUpdates.length).toBe(1);
  expect(documentTypeCatalogUpdates.at(-1)).toMatchObject({
    expectedRevision: "4",
    types: [
      {
        key: "product",
        fields: [{ key: "price", valueType: "number" }],
      },
    ],
  });
});

test("a key a rule could never match is rejected before the request leaves the browser", async ({ page }) => {
  const documentTypeCatalogUpdates: unknown[] = [];

  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    documentTypeCatalog: catalogWithProduct(),
    documentTypeCatalogUpdates,
  });

  await page.goto(`/w/${workspaceKey}/knowledge?tab=ingestion`);

  const catalog = page.getByTestId("document-type-catalog");
  const type = catalog.getByTestId("operator-type");
  await type.getByRole("button", { name: "Add field" }).click();

  const newField = catalog.getByTestId("operator-type-field").last();
  await newField.getByLabel("Key", { exact: true }).fill("product.price");
  await newField.getByLabel("Label", { exact: true }).fill("Price");

  await expect(catalog.getByText(
    'Field key "product.price" must be at most 64 characters, start with a letter, and contain only letters, digits, and underscores.',
  )).toBeVisible();
  await expect(catalog.getByRole("button", { name: "Save document types" })).toBeDisabled();
  expect(documentTypeCatalogUpdates).toHaveLength(0);
});
