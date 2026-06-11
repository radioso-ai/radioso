import type { Database } from "../../shared/infra/database.js";
import type { QueryResultRow } from "pg";
import type {
  WebhookDeliveryOutcomeStatus,
  WebhookDestinationRecord,
  WebhookDestinationRepositoryPort,
} from "../../modules/webhooks/public.js";

interface WebhookDestinationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  secret_ciphertext: string;
  encryption_key_id: string;
  last_delivery_status: string | null;
  last_delivery_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const mapRow = (row: WebhookDestinationRow): WebhookDestinationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  url: row.url,
  secretCiphertext: row.secret_ciphertext,
  encryptionKeyId: row.encryption_key_id,
  lastDeliveryStatus: row.last_delivery_status,
  lastDeliveryAt: row.last_delivery_at ? new Date(row.last_delivery_at) : null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const destinationColumns = `
  id::text,
  workspace_id::text,
  name,
  url,
  secret_ciphertext,
  encryption_key_id,
  last_delivery_status,
  last_delivery_at,
  created_at,
  updated_at
`;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isUuid = (value: string): boolean => uuidPattern.test(value);

export class WebhookDestinationRepository implements WebhookDestinationRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: {
    workspaceId: string;
    name: string;
    url: string;
    secretCiphertext: string;
    encryptionKeyId: string;
  }): Promise<WebhookDestinationRecord> {
    const row = await this.database.queryOne<WebhookDestinationRow>(
      `INSERT INTO workspace_webhook_destinations (
         workspace_id, name, url, secret_ciphertext, encryption_key_id
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${destinationColumns}`,
      [
        input.workspaceId,
        input.name,
        input.url,
        input.secretCiphertext,
        input.encryptionKeyId,
      ],
    );
    return mapRow(row);
  }

  async listByWorkspace(workspaceId: string): Promise<WebhookDestinationRecord[]> {
    const rows = await this.database.query<WebhookDestinationRow>(
      `SELECT ${destinationColumns}
       FROM workspace_webhook_destinations
       WHERE workspace_id = $1
       ORDER BY lower(name) ASC, created_at ASC, id ASC`,
      [workspaceId],
    );
    return rows.map(mapRow);
  }

  async findByIdAndWorkspace(id: string, workspaceId: string): Promise<WebhookDestinationRecord | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await this.database.queryOptional<WebhookDestinationRow>(
      `SELECT ${destinationColumns}
       FROM workspace_webhook_destinations
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return row ? mapRow(row) : null;
  }

  async update(
    id: string,
    workspaceId: string,
    input: { name: string; url: string },
  ): Promise<WebhookDestinationRecord | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await this.database.queryOptional<WebhookDestinationRow>(
      `UPDATE workspace_webhook_destinations
       SET name = $3,
           url = $4,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${destinationColumns}`,
      [id, workspaceId, input.name, input.url],
    );
    return row ? mapRow(row) : null;
  }

  async updateSecret(
    id: string,
    workspaceId: string,
    input: { secretCiphertext: string; encryptionKeyId: string },
  ): Promise<WebhookDestinationRecord | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await this.database.queryOptional<WebhookDestinationRow>(
      `UPDATE workspace_webhook_destinations
       SET secret_ciphertext = $3,
           encryption_key_id = $4,
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING ${destinationColumns}`,
      [id, workspaceId, input.secretCiphertext, input.encryptionKeyId],
    );
    return row ? mapRow(row) : null;
  }

  async recordDeliveryOutcome(
    id: string,
    workspaceId: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void> {
    if (!isUuid(id)) {
      return;
    }
    await this.database.execute(
      `UPDATE workspace_webhook_destinations
       SET last_delivery_status = $3,
           last_delivery_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId, status],
    );
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    if (!isUuid(id)) {
      return false;
    }
    const affected = await this.database.execute(
      `DELETE FROM workspace_webhook_destinations
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return affected > 0;
  }
}
