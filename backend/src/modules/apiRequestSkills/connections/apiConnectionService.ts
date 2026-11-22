import { AppError, badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import { isLocalDevelopmentHttpUrl, PublicHostUnresolvedError, PublicNetworkPolicyError } from "../../../shared/domain/publicNetwork.js";
import { skillTargetInUseError, type SkillTargetUse, type SkillTargetUseReader } from "../../../shared/domain/skillTargetUses.js";
import {
  decryptField,
  encryptField,
  maskSecret,
  type FieldEncryptionKeyRing,
} from "../../../shared/infra/crypto/fieldEncryption.js";
import { isUniqueViolation, pgErrorMeta } from "../../../shared/infra/kysely/sqlHelpers.js";
import {
  API_REQUEST_LIMITS,
  apiConnectionCreateSchema,
  apiConnectionMergedStateSchema,
  apiConnectionUpdateSchema,
  type ApiConnection,
  type ApiConnectionAuthScheme,
  type ApiConnectionCreateInput,
  type ApiConnectionRecord,
  type ApiConnectionTarget,
  type ApiConnectionUpdateInput,
  type ApiRequestFailureReason,
  type ApiRequestSkillOutcome,
  type ApiRequestTestInput,
} from "../domain.js";
import type { ApiConnectionTargetResolution, ApiConnectionTargetResolver } from "../executor/apiRequestSkillExecutor.js";
import { runApiRequest, type ApiRequestSender } from "../requestRunner.js";
import { previewJsonBody } from "../bodyPreview.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";
const IN_USE_CONSTRAINT = "agent_skills_api_request_target_fk";

/** The stored columns a write sets; the repository adds the id and timestamps. */
export interface ApiConnectionWrite {
  name: string;
  baseUrl: string;
  authScheme: ApiConnectionAuthScheme;
  authHeaderName: string | null;
  credentialCiphertext: string | null;
  defaultHeaders: Record<string, string>;
}

export interface ApiConnectionRepositoryPort {
  create(input: ApiConnectionWrite & { workspaceId: string }): Promise<ApiConnectionRecord>;
  listByWorkspace(workspaceId: string): Promise<ApiConnectionRecord[]>;
  findByIdAndWorkspace(id: string, workspaceId: string): Promise<ApiConnectionRecord | null>;
  update(id: string, workspaceId: string, input: ApiConnectionWrite): Promise<ApiConnectionRecord | null>;
  delete(id: string, workspaceId: string): Promise<boolean>;
}

interface ApiConnectionActor {
  accountId?: string | null;
}

/**
 * The one audit write the service makes, shaped like the audit module's own `record`. Declared
 * here rather than imported: the audit module reaches routines, which route API request skills,
 * so importing it would close a module cycle.
 */
interface ApiConnectionAuditPort {
  record(event: {
    accountId?: string;
    workspaceId: string;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/** What the operator's test request shows: the same outcome and outputs a skill would get, plus the body. */
interface ApiRequestTestResult {
  httpStatus: number | null;
  durationMs: number;
  outcome: ApiRequestSkillOutcome;
  reason?: ApiRequestFailureReason;
  /** The declared outputs, projected to their types: what a routine would get. */
  outputs: Record<string, unknown>;
  /** The required outputs the response left absent; empty unless the outcome is a response mismatch. */
  mismatches: string[];
  /** The parsed JSON body, cut down to 16 KB, for choosing output paths; null when empty or not JSON. */
  body: unknown;
  bodyTruncated: boolean;
}

class ApiConnectionEncryptionNotConfiguredError extends AppError {
  constructor() {
    super(
      503,
      "encryption_not_configured",
      `${KEY_NAME} is not configured; cannot store API connection credentials. Set ${KEY_NAME} to enable credential writes.`,
    );
  }
}

class ApiConnectionCredentialRequiredError extends AppError {
  constructor() {
    super(
      400,
      "credential_required",
      "Changing the base URL's origin, the auth scheme or the auth header name needs the credential again in the same update",
    );
  }
}

const originOf = (url: string): string => new URL(url).origin;

/**
 * What a read shows of a credential: the tail of a token or header value, as other connection
 * secrets show. A basic credential shows its username alone: the password's last characters, and
 * its length, are part of the secret.
 */
const credentialMaskFor = (authScheme: ApiConnectionAuthScheme, credential: string): string => {
  if (authScheme !== "basic") return maskSecret(credential);
  const separator = credential.indexOf(":");
  return separator > 0 ? `${credential.slice(0, separator)}:****` : "****";
};

/** Whether a patched connection would send its stored credential to another origin, scheme or header. */
const retargetsCredential = (
  existing: Pick<ApiConnectionRecord, "baseUrl" | "authScheme" | "authHeaderName">,
  next: { baseUrl: string; authScheme: ApiConnectionAuthScheme; authHeaderName: string | null },
): boolean =>
  originOf(next.baseUrl) !== originOf(existing.baseUrl)
  || next.authScheme !== existing.authScheme
  || (next.authHeaderName ?? "").toLowerCase() !== (existing.authHeaderName ?? "").toLowerCase();

/** The refusal to delete a connection skills use, in an agent's draft or its published release. */
const connectionInUse = (connectionId: string, uses: readonly SkillTargetUse[]): AppError =>
  skillTargetInUseError({
    code: "api_connection_in_use",
    targetLabel: "API connection",
    uses,
    details: { connectionId, references: [...new Set(uses.map((use) => `skill:${use.skillName}`))] },
  });

const isConstraint = (error: unknown, constraint: string): boolean => pgErrorMeta(error).constraint === constraint;

/**
 * Owns workspace API connections: their validation, the encrypted credential, the delete guard,
 * and the runtime target a request is sent through. The credential is write-only: reads return
 * only its masked tail.
 */
/**
 * The public-network guard's own refusal, worded for a base URL: the guard words it for any URL.
 * Anything else is no refusal, such as a fault in the guard, and goes on as it is.
 */
const baseUrlRefusal = (error: unknown): unknown => {
  if (error instanceof PublicHostUnresolvedError) return badRequest("Base URL host could not be resolved");
  if (error instanceof PublicNetworkPolicyError) return badRequest("Base URL must resolve to a publicly routable host");
  return error;
};

export class ApiConnectionService implements ApiConnectionTargetResolver {
  constructor(private readonly options: {
    repository: ApiConnectionRepositoryPort;
    auditService: ApiConnectionAuditPort;
    encryption: { key: FieldEncryptionKeyRing | undefined };
    /**
     * Checks a base URL's host resolves to a public address when it is saved. Refuses with
     * `PublicNetworkPolicyError`, or its `PublicHostUnresolvedError` when the host does not resolve.
     */
    assertPublicUrl: (url: string) => Promise<void>;
    /** Plain http to this machine as a base URL: local development and e2e only. */
    allowHttpLoopback?: boolean;
    send: ApiRequestSender;
    /** The skills that use a connection, which keep it from being deleted. */
    skillTargetUses: SkillTargetUseReader;
  }) {}

  async list(workspaceId: string): Promise<ApiConnection[]> {
    const records = await this.options.repository.listByWorkspace(workspaceId);
    return records.map((record) => this.toConnection(record));
  }

  async get(workspaceId: string, id: string): Promise<ApiConnection> {
    return this.toConnection(await this.requireRecord(workspaceId, id));
  }

  async create(input: { workspaceId: string; body: ApiConnectionCreateInput; actor: ApiConnectionActor }): Promise<ApiConnection> {
    const parsed = apiConnectionCreateSchema.safeParse(input.body);
    if (!parsed.success) throw badRequest("Invalid API connection", parsed.error.flatten());
    const write: ApiConnectionWrite = {
      name: parsed.data.name,
      baseUrl: await this.normalizeBaseUrl(parsed.data.baseUrl),
      authScheme: parsed.data.authScheme,
      authHeaderName: parsed.data.authHeaderName ?? null,
      credentialCiphertext: parsed.data.credential === undefined ? null : this.encrypt(parsed.data.credential),
      defaultHeaders: parsed.data.defaultHeaders,
    };
    const record = await this.persist(() => this.options.repository.create({ ...write, workspaceId: input.workspaceId }), write.name);
    await this.audit("api_connection.create", input.workspaceId, input.actor, record);
    return this.toConnection(record);
  }

  async update(input: { workspaceId: string; id: string; body: ApiConnectionUpdateInput; actor: ApiConnectionActor }): Promise<ApiConnection> {
    const parsed = apiConnectionUpdateSchema.safeParse(input.body);
    if (!parsed.success) throw badRequest("Invalid API connection", parsed.error.flatten());
    const existing = await this.requireRecord(input.workspaceId, input.id);
    const patch = parsed.data;
    const authScheme = patch.authScheme ?? existing.authScheme;
    // A scheme without a header name or a credential drops what the old scheme kept.
    const authHeaderName = authScheme === "header"
      ? (patch.authHeaderName === undefined ? existing.authHeaderName : patch.authHeaderName)
      : (patch.authHeaderName ?? null);
    const keepsCredential = authScheme !== "none" && patch.credential === undefined && existing.credentialCiphertext !== null;
    const defaultHeaders = patch.defaultHeaders ?? existing.defaultHeaders;
    const merged = apiConnectionMergedStateSchema.safeParse({
      authScheme,
      authHeaderName,
      defaultHeaders,
      hasCredential: keepsCredential || patch.credential !== undefined,
      ...(patch.credential === undefined ? {} : { credential: patch.credential }),
    });
    if (!merged.success) throw badRequest("Invalid API connection", merged.error.flatten());
    const baseUrl = patch.baseUrl === undefined ? existing.baseUrl : await this.normalizeBaseUrl(patch.baseUrl);
    // A stored credential goes only where it was entered for: moving it to another origin, or
    // sending it under another scheme or header, needs the credential typed again.
    if (keepsCredential && retargetsCredential(existing, { baseUrl, authScheme, authHeaderName })) {
      throw new ApiConnectionCredentialRequiredError();
    }
    const write: ApiConnectionWrite = {
      name: patch.name ?? existing.name,
      baseUrl,
      authScheme,
      authHeaderName,
      credentialCiphertext: authScheme === "none"
        ? null
        : patch.credential === undefined ? existing.credentialCiphertext : this.encrypt(patch.credential),
      defaultHeaders,
    };
    const record = await this.persist(() => this.options.repository.update(input.id, input.workspaceId, write), write.name);
    if (!record) throw notFound("API connection not found");
    await this.audit("api_connection.update", input.workspaceId, input.actor, record, {
      credentialChanged: patch.credential !== undefined || (existing.credentialCiphertext !== null && write.credentialCiphertext === null),
    });
    return this.toConnection(record);
  }

  async delete(workspaceId: string, id: string, actor: ApiConnectionActor): Promise<void> {
    const existing = await this.requireRecord(workspaceId, id);
    const uses = await this.skillUses(workspaceId, id);
    if (uses.length > 0) throw connectionInUse(id, uses);
    let deleted: boolean;
    try {
      deleted = await this.options.repository.delete(id, workspaceId);
    } catch (error) {
      // A skill took the connection after the check above, and the database's guard refused.
      if (isConstraint(error, IN_USE_CONSTRAINT)) throw connectionInUse(id, await this.skillUses(workspaceId, id));
      throw error;
    }
    if (!deleted) throw notFound("API connection not found");
    await this.audit("api_connection.delete", workspaceId, actor, existing);
  }

  async resolveTarget(workspaceId: string, connectionId: string): Promise<ApiConnectionTargetResolution> {
    const record = await this.options.repository.findByIdAndWorkspace(connectionId, workspaceId);
    if (!record) return { kind: "not_found" };
    const credential = record.credentialCiphertext === null ? null : this.tryDecrypt(record.credentialCiphertext);
    if (record.credentialCiphertext !== null && credential === null) return { kind: "credential_unavailable" };
    return { kind: "found", target: toTarget(record, credential) };
  }

  /**
   * Sends one request through the connection the way a skill would, for the operator choosing
   * output paths. It is a real request: a method other than GET acts on the target.
   */
  async testRequest(input: {
    workspaceId: string;
    connectionId: string;
    request: ApiRequestTestInput;
    actor: ApiConnectionActor;
  }): Promise<ApiRequestTestResult> {
    const resolved = await this.resolveTarget(input.workspaceId, input.connectionId);
    if (resolved.kind === "not_found") throw notFound("API connection not found");
    const run = resolved.kind === "credential_unavailable"
      ? { outcome: "failed" as const, reason: "credential_unavailable" as const, httpStatus: null, durationMs: 0, outputs: {} }
      : await runApiRequest({
          target: resolved.target,
          method: input.request.method,
          path: input.request.path,
          params: { ...input.request.boundParams, ...input.request.exposedSampleValues },
          outputs: input.request.outputs,
          send: this.options.send,
          keepBody: true,
        });
    const preview = run.body === undefined || run.body === null
      ? { body: null, truncated: false }
      : previewJsonBody(run.body, API_REQUEST_LIMITS.maxPreviewBytes);
    await this.options.auditService.record({
      accountId: input.actor.accountId ?? undefined,
      workspaceId: input.workspaceId,
      eventType: "api_connection.test_request",
      eventStatus: run.outcome === "failed" ? "failure" : "success",
      metadata: {
        connectionId: input.connectionId,
        method: input.request.method,
        outcome: run.outcome,
        ...(run.reason ? { reason: run.reason } : {}),
        ...(run.httpStatus === null ? {} : { httpStatus: run.httpStatus }),
      },
    });
    return {
      httpStatus: run.httpStatus,
      durationMs: run.durationMs,
      outcome: run.outcome,
      ...(run.reason ? { reason: run.reason } : {}),
      outputs: run.outputs,
      mismatches: run.missingOutputs ?? [],
      body: preview.body,
      bodyTruncated: preview.truncated,
    };
  }

  private skillUses(workspaceId: string, connectionId: string): Promise<SkillTargetUse[]> {
    return this.options.skillTargetUses.listSkillTargetUses({ workspaceId, targetType: "api_connection", targetId: connectionId });
  }

  private async requireRecord(workspaceId: string, id: string): Promise<ApiConnectionRecord> {
    const record = await this.options.repository.findByIdAndWorkspace(id, workspaceId);
    if (!record) throw notFound("API connection not found");
    return record;
  }

  private async persist<T>(write: () => Promise<T>, name: string): Promise<T> {
    try {
      return await write();
    } catch (error) {
      // The workspace-and-name index is the table's only unique constraint besides its key.
      if (isUniqueViolation(error)) {
        throw conflict(`An API connection named "${name}" already exists in this workspace`);
      }
      throw error;
    }
  }

  /**
   * https to a host that resolves to a public address, or plain http to this machine where
   * loopback is allowed. No credentials, query or fragment: the auth scheme carries credentials,
   * and a skill's params fill the query.
   */
  private async normalizeBaseUrl(value: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw badRequest("API connection base URL must be a valid URL");
    }
    if (url.username || url.password) throw badRequest("API connection base URL must not carry credentials");
    if (url.search || url.hash) throw badRequest("API connection base URL must not carry a query or fragment");
    const normalized = url.toString().replace(/\/+$/u, "");
    if (url.protocol === "http:" && this.options.allowHttpLoopback === true && isLocalDevelopmentHttpUrl(normalized)) {
      return normalized;
    }
    if (url.protocol !== "https:") throw badRequest("API connection base URL must use https");
    try {
      await this.options.assertPublicUrl(normalized);
    } catch (error) {
      throw baseUrlRefusal(error);
    }
    return normalized;
  }

  private encrypt(credential: string): string {
    const key = this.options.encryption.key;
    if (!key || key.current.length === 0) throw new ApiConnectionEncryptionNotConfiguredError();
    return encryptField(credential, key, { keyName: KEY_NAME });
  }

  private tryDecrypt(ciphertext: string): string | null {
    const key = this.options.encryption.key;
    if (!key || key.current.length === 0) return null;
    try {
      return decryptField(ciphertext, key, { keyName: KEY_NAME });
    } catch {
      return null;
    }
  }

  private toConnection(record: ApiConnectionRecord): ApiConnection {
    const credential = record.credentialCiphertext === null ? null : this.tryDecrypt(record.credentialCiphertext);
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      name: record.name,
      baseUrl: record.baseUrl,
      authScheme: record.authScheme,
      authHeaderName: record.authHeaderName,
      // A stored credential this key cannot read still exists: show that one is set, not its tail.
      credentialMask: record.credentialCiphertext === null ? null : credential === null ? "****" : credentialMaskFor(record.authScheme, credential),
      defaultHeaders: record.defaultHeaders,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async audit(
    eventType: string,
    workspaceId: string,
    actor: ApiConnectionActor,
    record: Pick<ApiConnectionRecord, "id" | "name" | "authScheme">,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.auditService.record({
      accountId: actor.accountId ?? undefined,
      workspaceId,
      eventType,
      eventStatus: "success",
      metadata: { connectionId: record.id, connectionName: record.name, authScheme: record.authScheme, ...extra },
    });
  }
}

const toTarget = (record: ApiConnectionRecord, credential: string | null): ApiConnectionTarget => ({
  id: record.id,
  baseUrl: record.baseUrl,
  authScheme: record.authScheme,
  authHeaderName: record.authHeaderName,
  credential,
  defaultHeaders: record.defaultHeaders,
});
