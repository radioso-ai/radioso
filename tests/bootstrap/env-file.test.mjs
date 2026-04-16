import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildEnvValues, parseEnvFile, renderEnvFile, writeEnvFileAtomic } from "../../scripts/bootstrap/env-file.mjs";

test("parseEnvFile ignores comments and reads values", () => {
  const values = parseEnvFile("# comment\nOPENAI_API_KEY=test\nLLM_PROVIDER=openai\n");
  assert.equal(values.OPENAI_API_KEY, "test");
  assert.equal(values.LLM_PROVIDER, "openai");
});

test("buildEnvValues preserves existing values unless overridden", () => {
  const values = buildEnvValues(
    { OPENAI_API_KEY: "existing", LLM_PROVIDER: "openai" },
    {
      SESSION_COOKIE_SECRET: "generated",
      WORKSPACE_TOKEN_SECRET: "workspace-secret",
      WEBSITE_EMBED_SECRET: "embed-secret",
      CONNECTOR_ENCRYPTION_KEY: "connector",
    },
  );

  assert.equal(values.OPENAI_API_KEY, "existing");
  assert.equal(values.SESSION_COOKIE_SECRET, "generated");
  assert.equal(values.WORKSPACE_TOKEN_SECRET, "workspace-secret");
  assert.equal(values.WEBSITE_EMBED_SECRET, "embed-secret");
});

test("writeEnvFileAtomic writes rendered env content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-bootstrap-"));
  const filePath = path.join(tempDir, ".env");
  const content = renderEnvFile({
    PORT: "8080",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://example",
    INTEGRATION_DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    OPENAI_CHAT_MODEL: "gpt-5.2",
    OPENAI_RERANK_MODEL: "gpt-5.2",
    OPENAI_VECTOR_MODEL: "text-embedding-3-small",
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
    WEBSITE_EMBED_SECRET: "embed-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "connector",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  await writeEnvFileAtomic(filePath, content);
  const written = await fs.readFile(filePath, "utf8");
  assert.match(written, /OPENAI_API_KEY=sk-test/);
});

test("renderEnvFile omits blank optional values", () => {
  const content = renderEnvFile({
    PORT: "8080",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://example",
    INTEGRATION_DATABASE_URL: "postgres://example",
    OPENAI_API_KEY: "sk-test",
    OPENAI_COMPATIBLE_API_KEY: "",
    OPENAI_COMPATIBLE_BASE_URL: "",
    LLM_PROVIDER: "openai",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
    WEBSITE_EMBED_SECRET: "embed-secret",
    SESSION_TTL_HOURS: "168",
    CONNECTOR_ENCRYPTION_KEY: "connector",
    DOCUMENT_UPLOAD_MAX_BYTES: "10485760",
    PUBLIC_CHAT_BASE_URL: "http://localhost:3000/chat",
  });

  assert.match(content, /OPENAI_API_KEY=sk-test/);
  assert.doesNotMatch(content, /OPENAI_COMPATIBLE_API_KEY=/);
  assert.doesNotMatch(content, /OPENAI_COMPATIBLE_BASE_URL=/);
});
