import { randomBytes } from "node:crypto";

import { AppError, badRequest, conflict, notFound } from "../../shared/domain/errors.js";
import { skillTargetInUseError, type RoutineExportUse, type SkillTargetUse, type SkillTargetUseReader } from "../../shared/domain/skillTargetUses.js";
import {
  decryptField,
  encryptField,
  type FieldEncryptionKeyRing,
} from "../../shared/infra/crypto/fieldEncryption.js";
import { normalizeWebhookTargetUrl, WebhookTargetUrlError } from "../../shared/infra/http/signedWebhook.js";
import { isForeignKeyViolationOn } from "../../shared/infra/kysely/sqlHelpers.js";
import type { AuditPort } from "../audit/contracts/index.js";
import {
  toWebhookDestination,
  type WebhookDeliveryOutcomeStatus,
  webhookDestinationCreateSchema,
  type WebhookDestination,
  type WebhookDestinationRecord,
  type WebhookDestinationWithSecret,
} from "./domain.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

export interface WebhookDestinationRepositoryPort {
  create(input: {
    workspaceId: string;
    name: string;
    url: string;
    secretCiphertext: string;
  }): Promise<WebhookDestinationRecord>;
  listByWorkspace(workspaceId: string): Promise<WebhookDestinationRecord[]>;
  findByIdAndWorkspace(id: string, workspaceId: string): Promise<WebhookDestinationRecord | null>;
  update(id: string, workspaceId: string, input: { name: string; url: string }): Promise<WebhookDestinationRecord | null>;
  updateSecret(id: string, workspaceId: string, input: {
    secretCiphertext: string;
  }): Promise<WebhookDestinationRecord | null>;
  recordDeliveryOutcome(id: string, workspaceId: string, status: WebhookDeliveryOutcomeStatus): Promise<void>;
  delete(id: string, workspaceId: string): Promise<boolean>;
}

export interface WebhookDestinationRoutineReferencePort {
  /** Every routine that exports to the destination, in an agent's draft or its published release. */
  listRoutineExportUses(workspaceId: string, destinationId: string): Promise<RoutineExportUse[]>;
}

export interface WebhookDestinationExistencePort {
  existsByIdAndWorkspace(workspaceId: string, destinationId: string): Promise<boolean>;
}

interface WebhookDestinationsEncryptionConfig {
  key: FieldEncryptionKeyRing | undefined;
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

/**
 * The refusal to delete a destination in use: by the completion export of a routine, or by a skill,
 * in an agent's draft or its published release.
 */
const destinationInUse = (destinationId: string, routineUses: readonly RoutineExportUse[], skillUses: readonly SkillTargetUse[]): AppError =>
  skillTargetInUseError({
    code: "webhook_destination_in_use",
    targetLabel: "Webhook destination",
    uses: skillUses,
    routineUses,
    details: {
      destinationId,
      references: [
        ...new Set(routineUses.map((use) => use.routineName)),
        ...new Set(skillUses.map((use) => `skill:${use.skillName}`)),
      ],
    },
  });

const SKILL_TARGET_CONSTRAINT = "agent_skills_webhook_target_fk";

type WebhookDestinationUrlGuard = (url: string) => Promise<void>;

const isDuplicateNameError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (record.constraint === "idx_workspace_webhook_destinations_workspace_lower_name") {
    return true;
  }
  const hasDuplicateMessage =
    typeof record.message === "string" && /duplicate key|unique constraint/i.test(record.message);
  return record.code === "23505" || hasDuplicateMessage;
};

const isPublishedRoutineReferenceError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown; message?: unknown };
  return record.code === "23503" &&
    (
      record.constraint === "workspace_webhook_destinations_published_routine_reference" ||
      (typeof record.message === "string" && /referenced by (?:published|enabled) routines/.test(record.message))
    );
};

export class WebhookDestinationService implements WebhookDestinationExistencePort {
  constructor(private readonly options: {
    repository: WebhookDestinationRepositoryPort;
    auditService: Pick<AuditPort, "record">;
    encryption: WebhookDestinationsEncryptionConfig;
    assertPublicUrl: WebhookDestinationUrlGuard;
    allowHttpLoopback?: boolean;
    routineReferences?: WebhookDestinationRoutineReferencePort;
    /** The skills that use a destination, which keep it from being deleted. */
    skillTargetUses: SkillTargetUseReader;
  }) {}

  isEncryptionConfigured(): boolean {
    const key = this.options.encryption.key;
    return key !== undefined && key.current.length > 0;
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
    const parsed = webhookDestinationCreateSchema.parse({ name: input.name, url: input.url });
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
    const [routineUses, skillUses] = await this.uses(workspaceId, id);
    if (routineUses.length > 0 || skillUses.length > 0) {
      throw destinationInUse(id, routineUses, skillUses);
    }
    const existing = await this.requireRecord(workspaceId, id);
    let deleted: boolean;
    try {
      deleted = await this.options.repository.delete(id, workspaceId);
    } catch (error) {
      // A routine or skill took the destination after the check above, and the database refused.
      if (isPublishedRoutineReferenceError(error) || isForeignKeyViolationOn(error, SKILL_TARGET_CONSTRAINT)) {
        throw destinationInUse(id, ...await this.uses(workspaceId, id));
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

  private async uses(workspaceId: string, destinationId: string): Promise<[RoutineExportUse[], SkillTargetUse[]]> {
    return Promise.all([
      this.options.routineReferences?.listRoutineExportUses(workspaceId, destinationId) ?? Promise.resolve([]),
      this.options.skillTargetUses.listSkillTargetUses({ workspaceId, targetType: "webhook_destination", targetId: destinationId }),
    ]);
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
    try {
      return await normalizeWebhookTargetUrl(value, {
        assertPublicUrl: this.options.assertPublicUrl,
        allowHttpLoopback: this.options.allowHttpLoopback,
      });
    } catch (error) {
      if (error instanceof WebhookTargetUrlError) {
        throw badRequest(error.problem === "invalid" ? "Webhook destination URL must be valid" : "Webhook destination URL must use https");
      }
      throw error;
    }
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
