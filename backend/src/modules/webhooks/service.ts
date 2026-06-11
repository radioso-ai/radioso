import { randomBytes } from "node:crypto";

import { AppError, badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import {
  decryptField,
  encryptField,
} from "../../shared/infra/crypto/fieldEncryption.js";
import type { AuditPort } from "../audit/contracts/index.js";
import {
  toWebhookDestination,
  type WebhookDeliveryOutcomeStatus,
  webhookDestinationCreateSchema,
  webhookDestinationUpdateSchema,
  type WebhookDestination,
  type WebhookDestinationRecord,
  type WebhookDestinationWithSecret,
} from "./domain.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";
const ENCRYPTION_KEY_ID = "connector";

export interface WebhookDestinationRepositoryPort {
  create(input: {
    workspaceId: string;
    name: string;
    url: string;
    secretCiphertext: string;
    encryptionKeyId: string;
  }): Promise<WebhookDestinationRecord>;
  listByWorkspace(workspaceId: string): Promise<WebhookDestinationRecord[]>;
  findByIdAndWorkspace(id: string, workspaceId: string): Promise<WebhookDestinationRecord | null>;
  update(id: string, workspaceId: string, input: { name: string; url: string }): Promise<WebhookDestinationRecord | null>;
  updateSecret(id: string, workspaceId: string, input: {
    secretCiphertext: string;
    encryptionKeyId: string;
  }): Promise<WebhookDestinationRecord | null>;
  recordDeliveryOutcome(id: string, workspaceId: string, status: WebhookDeliveryOutcomeStatus): Promise<void>;
  delete(id: string, workspaceId: string): Promise<boolean>;
}

export interface WebhookDestinationRoutineReferencePort {
  listPublishedRoutineNamesReferencingDestination(workspaceId: string, destinationId: string): Promise<string[]>;
}

export interface WebhookDestinationExistencePort {
  existsByIdAndWorkspace(workspaceId: string, destinationId: string): Promise<boolean>;
}

export interface WebhookDestinationsEncryptionConfig {
  key: string | undefined;
}

export interface WebhookDestinationActor {
  accountId?: string | null;
}

export class EncryptionNotConfiguredError extends AppError {
  constructor() {
    super(
      503,
      "encryption_not_configured",
      `${KEY_NAME} is not configured; cannot store webhook destination secrets. Set ${KEY_NAME} to enable secret writes.`,
    );
  }
}

export class WebhookDestinationInUseError extends AppError {
  constructor(destinationId: string, routineNames: string[]) {
    const routineSummary = routineNames.length > 0
      ? `: ${routineNames.join(", ")}`
      : "";
    super(
      409,
      "webhook_destination_in_use",
      `Webhook destination ${destinationId} is referenced by published routine(s)${routineSummary}`,
      { destinationId, routineNames },
    );
  }
}

export type WebhookDestinationUrlGuard = (url: string) => Promise<void>;

const isDuplicateNameError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return record.code === "23505" ||
    (typeof record.constraint === "string" && record.constraint.includes("workspace_webhook_destinations")) ||
    (typeof record.message === "string" && /duplicate key|unique constraint/i.test(record.message));
};

const isPublishedRoutineReferenceError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return record.code === "23503" &&
    (
      record.constraint === "workspace_webhook_destinations_published_routine_reference" ||
      (typeof record.message === "string" && record.message.includes("referenced by published routines"))
    );
};

const isLoopbackHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
  } catch {
    return false;
  }
};

export class WebhookDestinationService implements WebhookDestinationExistencePort {
  constructor(private readonly options: {
    repository: WebhookDestinationRepositoryPort;
    auditService: Pick<AuditPort, "record">;
    encryption: WebhookDestinationsEncryptionConfig;
    assertPublicUrl: WebhookDestinationUrlGuard;
    allowHttpLoopback?: boolean;
    routineReferences?: WebhookDestinationRoutineReferencePort;
  }) {}

  isEncryptionConfigured(): boolean {
    return typeof this.options.encryption.key === "string" && this.options.encryption.key.length > 0;
  }

  async create(input: {
    workspaceId: string;
    name: string;
    url: string;
    actor: WebhookDestinationActor;
  }): Promise<WebhookDestinationWithSecret> {
    const parsed = webhookDestinationCreateSchema.parse({ name: input.name, url: input.url });
    const url = await this.normalizeAllowedDestinationUrl(parsed.url);
    const secret = this.generateSecret();
    const secretCiphertext = this.encryptSecret(secret);
    try {
      const record = await this.options.repository.create({
        workspaceId: input.workspaceId,
        name: parsed.name,
        url,
        secretCiphertext,
        encryptionKeyId: ENCRYPTION_KEY_ID,
      });
      await this.recordAudit("workspace_webhook_destination.create", "success", {
        workspaceId: input.workspaceId,
        actor: input.actor,
        destination: record,
      });
      return { destination: toWebhookDestination(record), secret };
    } catch (error) {
      await this.recordAudit("workspace_webhook_destination.create", "failure", {
        workspaceId: input.workspaceId,
        actor: input.actor,
        destinationName: parsed.name,
        reason: isDuplicateNameError(error) ? "duplicate_name" : "write_failed",
      });
      if (isDuplicateNameError(error)) {
        throw conflict(`Webhook destination named "${parsed.name}" already exists in this workspace`);
      }
      throw error;
    }
  }

  async list(workspaceId: string): Promise<WebhookDestination[]> {
    const records = await this.options.repository.listByWorkspace(workspaceId);
    return records.map(toWebhookDestination);
  }

  async get(workspaceId: string, id: string): Promise<WebhookDestination> {
    const record = await this.requireRecord(workspaceId, id);
    return toWebhookDestination(record);
  }

  async update(input: {
    workspaceId: string;
    id: string;
    name: string;
    url: string;
    actor: WebhookDestinationActor;
  }): Promise<WebhookDestination> {
    const parsed = webhookDestinationUpdateSchema.parse({ name: input.name, url: input.url });
    const url = await this.normalizeAllowedDestinationUrl(parsed.url);
    try {
      const record = await this.options.repository.update(input.id, input.workspaceId, {
        name: parsed.name,
        url,
      });
      if (!record) {
        throw notFound("Webhook destination not found");
      }
      await this.recordAudit("workspace_webhook_destination.update", "success", {
        workspaceId: input.workspaceId,
        actor: input.actor,
        destination: record,
      });
      return toWebhookDestination(record);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      await this.recordAudit("workspace_webhook_destination.update", "failure", {
        workspaceId: input.workspaceId,
        actor: input.actor,
        destinationId: input.id,
        destinationName: parsed.name,
        reason: isDuplicateNameError(error) ? "duplicate_name" : "write_failed",
      });
      if (isDuplicateNameError(error)) {
        throw conflict(`Webhook destination named "${parsed.name}" already exists in this workspace`);
      }
      throw error;
    }
  }

  async rotateSecret(
    workspaceId: string,
    id: string,
    actor: WebhookDestinationActor,
  ): Promise<WebhookDestinationWithSecret> {
    const secret = this.generateSecret();
    const record = await this.options.repository.updateSecret(id, workspaceId, {
      secretCiphertext: this.encryptSecret(secret),
      encryptionKeyId: ENCRYPTION_KEY_ID,
    });
    if (!record) {
      throw notFound("Webhook destination not found");
    }
    await this.recordAudit("workspace_webhook_destination.rotate_secret", "success", {
      workspaceId,
      actor,
      destination: record,
    });
    return { destination: toWebhookDestination(record), secret };
  }

  async delete(workspaceId: string, id: string, actor: WebhookDestinationActor): Promise<void> {
    const references = await this.options.routineReferences
      ?.listPublishedRoutineNamesReferencingDestination(workspaceId, id) ?? [];
    if (references.length > 0) {
      throw new WebhookDestinationInUseError(id, references);
    }
    const existing = await this.requireRecord(workspaceId, id);
    let deleted: boolean;
    try {
      deleted = await this.options.repository.delete(id, workspaceId);
    } catch (error) {
      if (isPublishedRoutineReferenceError(error)) {
        const latestReferences = await this.options.routineReferences
          ?.listPublishedRoutineNamesReferencingDestination(workspaceId, id) ?? [];
        throw new WebhookDestinationInUseError(id, latestReferences);
      }
      throw error;
    }
    if (!deleted) {
      throw notFound("Webhook destination not found");
    }
    await this.recordAudit("workspace_webhook_destination.delete", "success", {
      workspaceId,
      actor,
      destination: existing,
    });
  }

  async existsByIdAndWorkspace(workspaceId: string, destinationId: string): Promise<boolean> {
    return Boolean(await this.options.repository.findByIdAndWorkspace(destinationId, workspaceId));
  }

  async resolveSecret(workspaceId: string, destinationId: string): Promise<string | null> {
    const record = await this.options.repository.findByIdAndWorkspace(destinationId, workspaceId);
    if (!record) {
      return null;
    }
    return this.decryptSecret(record.secretCiphertext);
  }

  async resolveDestinationWithSecret(workspaceId: string, destinationId: string): Promise<{
    url: string;
    secret: string;
  } | null> {
    const record = await this.options.repository.findByIdAndWorkspace(destinationId, workspaceId);
    if (!record) {
      return null;
    }
    return { url: record.url, secret: this.decryptSecret(record.secretCiphertext) };
  }

  async recordDeliveryOutcome(
    workspaceId: string,
    destinationId: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void> {
    await this.options.repository.recordDeliveryOutcome(destinationId, workspaceId, status);
  }

  private async requireRecord(workspaceId: string, id: string): Promise<WebhookDestinationRecord> {
    const record = await this.options.repository.findByIdAndWorkspace(id, workspaceId);
    if (!record) {
      throw notFound("Webhook destination not found");
    }
    return record;
  }

  private encryptSecret(secret: string): string {
    if (!this.isEncryptionConfigured()) {
      throw new EncryptionNotConfiguredError();
    }
    return encryptField(secret, this.options.encryption.key!, { keyName: KEY_NAME });
  }

  private decryptSecret(ciphertext: string): string {
    if (!this.isEncryptionConfigured()) {
      throw new EncryptionNotConfiguredError();
    }
    return decryptField(ciphertext, this.options.encryption.key!, { keyName: KEY_NAME });
  }

  private generateSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  private async normalizeAllowedDestinationUrl(value: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw badRequest("Webhook destination URL must be valid");
    }

    const normalized = value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/u, url.protocol);
    if (url.protocol === "http:" && this.options.allowHttpLoopback === true && isLoopbackHttpUrl(value)) {
      return normalized;
    }
    if (url.protocol !== "https:") {
      throw badRequest("Webhook destination URL must use https");
    }
    await this.options.assertPublicUrl(normalized);
    return normalized;
  }

  private async recordAudit(
    eventType: string,
    eventStatus: "success" | "failure",
    input: {
      workspaceId: string;
      actor: WebhookDestinationActor;
      destination?: Pick<WebhookDestinationRecord, "id" | "name">;
      destinationId?: string;
      destinationName?: string;
      reason?: string;
    },
  ): Promise<void> {
    await this.options.auditService.record({
      accountId: input.actor.accountId ?? undefined,
      workspaceId: input.workspaceId,
      eventType,
      eventStatus,
      metadata: {
        destinationId: input.destination?.id ?? input.destinationId,
        destinationName: input.destination?.name ?? input.destinationName,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
  }
}
