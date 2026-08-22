import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { DocumentTypeCatalogRepository } from "../../src/db/repositories/documentTypeCatalogRepository.js";
import type { OperatorDocumentTypeDefinition } from "../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// Real-Postgres characterization of the catalog store. The conditional write is
// the concurrency contract two operators depend on, so it is exercised against
// actual SQL rather than a fake.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("DocumentTypeCatalogRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new DocumentTypeCatalogRepository(database.kysely);

  const accountId = randomUUID();
  const workspaceId = randomUUID();

  const productType: OperatorDocumentTypeDefinition = {
    key: "product",
    label: "Product",
    description: "A product detail page.",
    enabled: true,
    fields: [{ key: "price", label: "Price", valueType: "number", instruction: "The listed price." }],
  };

  beforeAll(async () => {
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [accountId, "Catalog Test Co", `catalog-${accountId}@example.com`, "hash"],
    );
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)`,
      [workspaceId, accountId, "Catalog Workspace", `catalog-route-${workspaceId}`],
    );
  });

  afterEach(async () => {
    await database.query("DELETE FROM document_type_catalogs WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("reads as absent before the first save", async () => {
    expect(await repository.findByWorkspaceId(workspaceId)).toBeNull();
  });

  it("inserts the first catalog at revision 2 and round-trips its JSONB", async () => {
    const saved = await repository.save({
      workspaceId,
      expectedRevision: "1",
      types: [productType],
      retiredFields: [{ key: "colour", valueType: "string" }],
      disabledBuiltInTypeKeys: ["profile"],
    });

    expect(saved?.revision).toBe("2");

    const reread = await repository.findByWorkspaceId(workspaceId);
    expect(reread).toMatchObject({
      workspaceId,
      revision: "2",
      disabledBuiltInTypeKeys: ["profile"],
      retiredFields: [{ key: "colour", valueType: "string" }],
    });
    expect(reread?.types).toEqual([productType]);
  });

  it("rejects a first save that claims a revision the workspace never had", async () => {
    const saved = await repository.save({
      workspaceId,
      expectedRevision: "7",
      types: [],
      retiredFields: [],
      disabledBuiltInTypeKeys: [],
    });

    expect(saved).toBeNull();
    expect(await repository.findByWorkspaceId(workspaceId)).toBeNull();
  });

  it("bumps the revision on each accepted write", async () => {
    await repository.save({
      workspaceId,
      expectedRevision: "1",
      types: [],
      retiredFields: [],
      disabledBuiltInTypeKeys: [],
    });
    const second = await repository.save({
      workspaceId,
      expectedRevision: "2",
      types: [productType],
      retiredFields: [],
      disabledBuiltInTypeKeys: [],
    });

    expect(second?.revision).toBe("3");
  });

  it("rejects a stale write and leaves the stored catalog untouched", async () => {
    await repository.save({
      workspaceId,
      expectedRevision: "1",
      types: [productType],
      retiredFields: [],
      disabledBuiltInTypeKeys: [],
    });

    const stale = await repository.save({
      workspaceId,
      expectedRevision: "1",
      types: [],
      retiredFields: [],
      disabledBuiltInTypeKeys: [],
    });

    expect(stale).toBeNull();
    const current = await repository.findByWorkspaceId(workspaceId);
    expect(current?.revision).toBe("2");
    expect(current?.types).toEqual([productType]);
  });
});
