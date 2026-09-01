import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { retireIntegrationDatabaseUrl } from "../../scripts/bootstrap/retire-integration-database-url.mjs";

test("the retirement CLI preserves custom .env content while removing only integration database assignments", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-retire-integration-url-"));
  const envPath = path.join(tempDir, ".env");
  const source = [
    "# Preserve this operator comment.",
    "CUSTOM_DEPLOYMENT_SETTING = preserve-me",
    "INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso_test",
    "export INTEGRATION_DATABASE_URL = postgres://postgres:postgres@localhost:5432/another_test",
    "ANOTHER_CUSTOM_SETTING=also-preserve",
    "",
  ].join("\n");
  await fs.writeFile(envPath, source, "utf8");

  try {
    const changed = await retireIntegrationDatabaseUrl(envPath);

    assert.equal(changed, true);
    assert.equal(
      await fs.readFile(envPath, "utf8"),
      [
        "# Preserve this operator comment.",
        "CUSTOM_DEPLOYMENT_SETTING = preserve-me",
        "ANOTHER_CUSTOM_SETTING=also-preserve",
        "",
      ].join("\n"),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("the retirement CLI leaves an env file without the retired key untouched", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-retire-integration-url-"));
  const envPath = path.join(tempDir, ".env");
  const source = "# Existing comment\nCUSTOM_DEPLOYMENT_SETTING=preserve-me\n";
  await fs.writeFile(envPath, source, "utf8");

  try {
    assert.equal(await retireIntegrationDatabaseUrl(envPath), false);
    assert.equal(await fs.readFile(envPath, "utf8"), source);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("the retirement CLI preserves CRLF line endings while removing the retired assignment", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-retire-integration-url-"));
  const envPath = path.join(tempDir, ".env");
  const source = [
    "# Preserve CRLF comments.",
    "CUSTOM_DEPLOYMENT_SETTING=preserve-me",
    "INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso_test",
    "ANOTHER_CUSTOM_SETTING=also-preserve",
    "",
  ].join("\r\n");
  await fs.writeFile(envPath, source, "utf8");

  try {
    assert.equal(await retireIntegrationDatabaseUrl(envPath), true);
    assert.equal(
      await fs.readFile(envPath, "utf8"),
      [
        "# Preserve CRLF comments.",
        "CUSTOM_DEPLOYMENT_SETTING=preserve-me",
        "ANOTHER_CUSTOM_SETTING=also-preserve",
        "",
      ].join("\r\n"),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
