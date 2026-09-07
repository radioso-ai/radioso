import { randomBytes } from "node:crypto";

import { notFound } from "../../../shared/domain/errors.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import { buildAppConnectionBinding } from "../domain/connectionBinding.js";
import { AppsError } from "../domain/errors.js";
import type { AppConnectionRecord } from "../domain/records.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppSecretCipherPort } from "../ports/secretCipher.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";

interface BindAppConnectionRequest {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly slotId: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly principal: AppOperatorPrincipal;
}

interface BindAppConnectionResult {
  readonly connection: AppConnectionRecord;
  /**
   * Present only on the response that mints it, and only for a `generated_secret` slot.
   * There is no read path that returns it again.
   */
  readonly generatedSecret: string | null;
}

interface AppConnectionServiceDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly cipher: AppSecretCipherPort;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly audit: Pick<AuditPort, "record">;
}

export class AppConnectionService {
  constructor(private readonly dependencies: AppConnectionServiceDependencies) {}

  /** Write-only: values go in, an identifier and the slot's non-sensitive fields come out. */
  async bind(request: BindAppConnectionRequest): Promise<BindAppConnectionResult> {
    await this.dependencies.authorization.requireAppAdministration(request.principal, request.workspaceId);

    const installation = await this.dependencies.installations.findById(request.workspaceId, request.installationId);
    if (!installation || installation.state === "removed") throw notFound("App installation not found");

    const releaseId = installation.activeReleaseId ?? installation.candidateReleaseId;
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) throw notFound("App release not found");

    const slot = release.manifest.connections.slots.find((candidate) => candidate.id === request.slotId);
    if (!slot) {
      throw new AppsError("connection_slot_unknown", "This release declares no such connection.", {
        slotId: request.slotId,
      });
    }

    const existing = (await this.dependencies.connections.listByInstallation(installation.id))
      .some((connection) => connection.slotId === slot.id);

    const binding = buildAppConnectionBinding({
      slot,
      values: request.values,
      generateSecret: (byteLength) => randomBytes(byteLength).toString("base64url"),
    });

    const connection = await this.dependencies.connections.bind({
      installationId: installation.id,
      slotId: binding.slotId,
      kind: binding.kind,
      publicFields: binding.publicFields,
      secretCiphertext: binding.secret === null ? null : this.dependencies.cipher.encrypt(binding.secret),
      encryptionKeyId: binding.secret === null ? null : this.dependencies.cipher.keyId,
    });

    await this.dependencies.audit.record({
      accountId: request.principal.accountId,
      workspaceId: request.workspaceId,
      eventType: existing ? "app.connection.rotated" : "app.connection.bound",
      eventStatus: "success",
      metadata: {
        installationId: installation.id,
        appId: installation.appId,
        connectionId: connection.id,
        slotId: connection.slotId,
        slotKind: connection.kind,
        // Field *names* the operator filled in. Never a value.
        publicFieldKeys: Object.keys(connection.publicFields),
        hasSecret: connection.hasSecret,
      },
    });

    return { connection, generatedSecret: binding.generatedSecret };
  }

  list(installationId: string): Promise<AppConnectionRecord[]> {
    return this.dependencies.connections.listByInstallation(installationId);
  }
}
