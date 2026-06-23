import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  WebhookDeliveryOutcomeStatus,
  WebhookDestinationRecord,
  WebhookDestinationRepositoryPort,
} from "../../modules/webhooks/public.js";

interface WebhookDestinationRow {
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

const destinationColumns = [
  "id",
  "workspace_id",
  "name",
  "url",
  "secret_ciphertext",
  "encryption_key_id",
  "last_delivery_status",
  "last_delivery_at",
  "created_at",
  "updated_at",
] as const;

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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isUuid = (value: string): boolean => uuidPattern.test(value);

export class WebhookDestinationRepository implements WebhookDestinationRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: {
    workspaceId: string;
    name: string;
    url: string;
    secretCiphertext: string;
    encryptionKeyId: string;
  }): Promise<WebhookDestinationRecord> {
    const row = await this.db
      .insertInto("workspace_webhook_destinations")
      .values({
        workspace_id: input.workspaceId,
        name: input.name,
        url: input.url,
        secret_ciphertext: input.secretCiphertext,
        encryption_key_id: input.encryptionKeyId,
      })
      .returning(destinationColumns)
      .executeTakeFirstOrThrow();
    return mapRow(row as WebhookDestinationRow);
  }

  async listByWorkspace(workspaceId: string): Promise<WebhookDestinationRecord[]> {
    const rows = await this.db
      .selectFrom("workspace_webhook_destinations")
      .select(destinationColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy((eb) => eb.fn<string>("lower", ["name"]), "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => mapRow(row as WebhookDestinationRow));
  }

  async findByIdAndWorkspace(id: string, workspaceId: string): Promise<WebhookDestinationRecord | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await this.db
      .selectFrom("workspace_webhook_destinations")
      .select(destinationColumns)
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapRow(row as WebhookDestinationRow) : null;
  }

  async update(
    id: string,
    workspaceId: string,
    input: { name: string; url: string },
  ): Promise<WebhookDestinationRecord | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await this.db
      .updateTable("workspace_webhook_destinations")
      .set({ name: input.name, url: input.url, updated_at: currentTimestamp() })
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .returning(destinationColumns)
      .executeTakeFirst();
    return row ? mapRow(row as WebhookDestinationRow) : null;
  }

  async updateSecret(
    id: string,
    workspaceId: string,
    input: { secretCiphertext: string; encryptionKeyId: string },
  ): Promise<WebhookDestinationRecord | null> {
    if (!isUuid(id)) {
      return null;
    }
    const row = await this.db
      .updateTable("workspace_webhook_destinations")
      .set({
        secret_ciphertext: input.secretCiphertext,
        encryption_key_id: input.encryptionKeyId,
        updated_at: currentTimestamp(),
      })
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .returning(destinationColumns)
      .executeTakeFirst();
    return row ? mapRow(row as WebhookDestinationRow) : null;
  }

  async recordDeliveryOutcome(
    id: string,
    workspaceId: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void> {
    if (!isUuid(id)) {
      return;
    }
    await this.db
      .updateTable("workspace_webhook_destinations")
      .set({ last_delivery_status: status, last_delivery_at: currentTimestamp(), updated_at: currentTimestamp() })
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .execute();
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    if (!isUuid(id)) {
      return false;
    }
    const result = await this.db
      .deleteFrom("workspace_webhook_destinations")
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
