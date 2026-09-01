import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("the common development launcher never aliases the integration database", async () => {
  const source = await fs.readFile("scripts/run-common-db-dev.sh", "utf8");

  assert.doesNotMatch(source, /export\s+INTEGRATION_DATABASE_URL/);
  assert.doesNotMatch(source, /INTEGRATION_DATABASE_URL=.*DATABASE_URL/);
});

test("local CI always provisions and marks its own disposable integration database", async () => {
  const source = await fs.readFile("scripts/local-ci-checks.sh", "utf8");

  assert.doesNotMatch(source, /Using existing INTEGRATION_DATABASE_URL/);
  assert.match(source, /unset\s+INTEGRATION_DATABASE_URL/);
  assert.match(source, /RADIOSO_INTEGRATION_DATABASE_NAME=radioso_test/);
  assert.match(source, /test:integration:prepare/);
});

test("normal application environment files do not configure an integration database", async () => {
  const example = await fs.readFile(".env.example", "utf8");
  const contract = await fs.readFile("scripts/bootstrap/support/env-contract.mjs", "utf8");

  assert.doesNotMatch(example, /^INTEGRATION_DATABASE_URL=/m);
  assert.doesNotMatch(contract, /^\s*"INTEGRATION_DATABASE_URL",?$/m);
});

test("Docker application containers override a stale integration database URL from .env", async () => {
  const compose = await fs.readFile("docker-compose.yml", "utf8");
  const serviceStarts = [...compose.matchAll(/^  [a-z][a-z-]*:\n/gm)].map((match) => match.index);

  for (const service of ["backend", "backend-worker", "backend-crawler-worker", "frontend"]) {
    const serviceStart = compose.indexOf(`  ${service}:`);
    assert.ok(serviceStart >= 0, `${service} must exist in docker-compose.yml`);
    const nextService = serviceStarts.find((start) => start > serviceStart);
    const serviceDefinition = compose.slice(serviceStart, nextService === -1 ? undefined : nextService);
    assert.match(
      serviceDefinition,
      /^      INTEGRATION_DATABASE_URL:\s*""$/m,
      `${service} must clear any legacy INTEGRATION_DATABASE_URL inherited from .env`,
    );
  }
});

test("enterprise database tests verify any configured integration database", async () => {
  const config = await fs.readFile("ee/packages/backend-module/vitest.config.ts", "utf8");
  const setup = await fs.readFile("ee/packages/backend-module/integrationDatabaseGlobalSetup.ts", "utf8");

  assert.match(config, /globalSetup/);
  assert.match(setup, /assertMarkedIntegrationDatabase/);
});

test("preparation verifies live database identities before writing the disposable marker", async () => {
  const source = await fs.readFile("backend/scripts/prepareIntegrationDatabase.ts", "utf8");
  const identityCheck = source.indexOf("await assertIntegrationDatabaseIdentityIsSafe");
  const markerWrite = source.indexOf("COMMENT ON DATABASE");

  assert.ok(identityCheck >= 0, "preparation must compare live database identities");
  assert.ok(markerWrite >= 0, "preparation must write the disposable marker");
  assert.ok(identityCheck < markerWrite, "preparation must compare identities before marking a database");
});
