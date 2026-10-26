import { createCipheriv, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  parseCredentialReencryptionArgs,
  runCredentialReencryptionCommand,
} from "../../src/app/cli/credentialReencryptionCommand.js";
import {
  ENCRYPTED_FIELD_LOCATIONS,
  EncryptedFieldRepository,
  type EncryptedFieldLocation,
  type EncryptedFieldRow,
} from "../../src/db/repositories/encryptedFieldRepository.js";
import {
  encryptField,
  encryptFieldAs,
  FIELD_ENCRYPTION_WRITE_FORMAT,
  fieldEncryptionKeyId,
  openEncryptedField,
} from "../../src/shared/infra/crypto/fieldEncryption.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const CURRENT_KEY = randomBytes(32).toString("base64");
const PREVIOUS_KEY = randomBytes(32).toString("base64");

/** The stored form written before ciphertext named its key. */
const encryptUnkeyed = (plaintext: string, keyBase64: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64");
};

const locationOf = (label: string): EncryptedFieldLocation => {
  const location = ENCRYPTED_FIELD_LOCATIONS.find((candidate) => candidate.label === label);
  if (!location) throw new Error(`${label} is not a registered location`);
  return location;
};

describeIntegration("EncryptedFieldRepository (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new EncryptedFieldRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const agentId = randomUUID();

  /** Every row of a location, a page at a time, the way the command reads it. */
  const readAll = async (location: EncryptedFieldLocation, limit: number): Promise<EncryptedFieldRow[]> => {
    const rows: EncryptedFieldRow[] = [];
    let after: readonly string[] | null = null;
    for (;;) {
      const page = await repository.readBatch(location, after, limit);
      rows.push(...page);
      const last = page.at(-1);
      if (page.length < limit || !last) return rows;
      after = last.key;
    }
  };

  const insertWebhookDestination = async (secretCiphertext: string): Promise<string> => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO workspace_webhook_destinations (id, workspace_id, name, url, secret_ciphertext)
       VALUES ($1, $2, $3, 'https://hooks.example.com', $4)`,
      [id, workspaceId, `Hook ${id}`, secretCiphertext],
    );
    return id;
  };

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Key Rotation Co",
      `acct-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Key Rotation Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO agents (id, workspace_id) VALUES ($1,$2)`, [agentId, workspaceId]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("pages through a table in primary key order, a composite key included", async () => {
    for (const provider of ["openai", "gemini", "claude"]) {
      await database.query(
        `INSERT INTO workspace_provider_credentials (workspace_id, provider, ciphertext) VALUES ($1, $2, $3)`,
        [workspaceId, provider, `cipher-${provider}`],
      );
    }

    const rows = await readAll(locationOf("workspace_provider_credentials.ciphertext"), 2);

    const keys = rows.map((row) => row.key.join("/"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.filter((row) => row.key[0] === workspaceId)).toEqual([
      { key: [workspaceId, "claude"], value: "cipher-claude" },
      { key: [workspaceId, "gemini"], value: "cipher-gemini" },
      { key: [workspaceId, "openai"], value: "cipher-openai" },
    ]);
  });

  it("writes a value only while the row still holds the one that was read", async () => {
    const location = locationOf("workspace_webhook_destinations.secret_ciphertext");
    const id = await insertWebhookDestination("as-read");

    expect(await repository.compareAndSwap(location, [id], "edited-since", "re-encrypted")).toBe(false);
    expect(await repository.compareAndSwap(location, [id], "as-read", "re-encrypted")).toBe(true);

    const [row] = await database.query<{ secret_ciphertext: string }>(
      `SELECT secret_ciphertext FROM workspace_webhook_destinations WHERE id = $1`,
      [id],
    );
    expect(row?.secret_ciphertext).toBe("re-encrypted");
  });

  it("re-encrypts every registered location onto the current key", async () => {
    const connectorId = randomUUID();
    const config = { site_url: "https://example.com", api_token: encryptUnkeyed("wp-token", PREVIOUS_KEY) };
    await database.query(
      `INSERT INTO connector_configs (id, workspace_id, connector_id, config_data) VALUES ($1, $2, 'wordpress', $3::jsonb)`,
      [connectorId, workspaceId, JSON.stringify(config)],
    );
    const oauthId = randomUUID();
    await database.query(
      `INSERT INTO integration_oauth_connections
         (id, workspace_id, provider, display_name, credential_ciphertext, oauth_client_ciphertext, oauth_flow_ciphertext)
       VALUES ($1, $2, 'slack', 'Slack', $3, $4, $5)`,
      [
        oauthId,
        workspaceId,
        encryptField("oauth-tokens", PREVIOUS_KEY),
        encryptUnkeyed("oauth-client", PREVIOUS_KEY),
        encryptUnkeyed("oauth-flow", CURRENT_KEY),
      ],
    );
    const mcpId = randomUUID();
    await database.query(
      `INSERT INTO mcp_connections
         (id, agent_id, display_name, server_url, auth_method, credential_ciphertext, oauth_client_ciphertext, oauth_flow_ciphertext)
       VALUES ($1, $2, 'Server', 'https://mcp.example.com', 'access_token', $3, $4, $5)`,
      [
        mcpId,
        agentId,
        encryptFieldAs("keyed", "mcp-token", PREVIOUS_KEY),
        encryptField("mcp-client", PREVIOUS_KEY),
        encryptUnkeyed("mcp-flow", PREVIOUS_KEY),
      ],
    );
    await database.query(
      `INSERT INTO workspace_provider_credentials (workspace_id, provider, ciphertext) VALUES ($1, 'elevenlabs', $2)`,
      [workspaceId, encryptUnkeyed("provider-key", PREVIOUS_KEY)],
    );
    const webhookId = await insertWebhookDestination(encryptFieldAs("keyed", "webhook-secret", PREVIOUS_KEY));

    await runCredentialReencryptionCommand(parseCredentialReencryptionArgs(["--apply"]), {
      keys: { current: CURRENT_KEY, previous: [PREVIOUS_KEY] },
      locations: ENCRYPTED_FIELD_LOCATIONS,
      store: repository,
      print: () => undefined,
    });

    const currentInWriteFormat = (plaintext: string) => ({
      plaintext,
      keyId: fieldEncryptionKeyId(CURRENT_KEY),
      format: FIELD_ENCRYPTION_WRITE_FORMAT,
    });
    const [connector] = await database.query<{ config_data: Record<string, string> }>(
      `SELECT config_data FROM connector_configs WHERE id = $1`,
      [connectorId],
    );
    expect(connector?.config_data.site_url).toBe("https://example.com");
    expect(openEncryptedField(connector.config_data.api_token, CURRENT_KEY)).toEqual(currentInWriteFormat("wp-token"));
    const [oauth] = await database.query<Record<string, string>>(
      `SELECT credential_ciphertext, oauth_client_ciphertext, oauth_flow_ciphertext FROM integration_oauth_connections WHERE id = $1`,
      [oauthId],
    );
    expect(openEncryptedField(oauth.credential_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("oauth-tokens"));
    expect(openEncryptedField(oauth.oauth_client_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("oauth-client"));
    expect(openEncryptedField(oauth.oauth_flow_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("oauth-flow"));
    const [mcp] = await database.query<Record<string, string>>(
      `SELECT credential_ciphertext, oauth_client_ciphertext, oauth_flow_ciphertext FROM mcp_connections WHERE id = $1`,
      [mcpId],
    );
    expect(openEncryptedField(mcp.credential_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("mcp-token"));
    expect(openEncryptedField(mcp.oauth_client_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("mcp-client"));
    expect(openEncryptedField(mcp.oauth_flow_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("mcp-flow"));
    const [provider] = await database.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM workspace_provider_credentials WHERE workspace_id = $1 AND provider = 'elevenlabs'`,
      [workspaceId],
    );
    expect(openEncryptedField(provider.ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("provider-key"));
    const [webhook] = await database.query<{ secret_ciphertext: string }>(
      `SELECT secret_ciphertext FROM workspace_webhook_destinations WHERE id = $1`,
      [webhookId],
    );
    expect(openEncryptedField(webhook.secret_ciphertext, CURRENT_KEY)).toEqual(currentInWriteFormat("webhook-secret"));
  });
});
