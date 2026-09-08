import { randomBytes } from "node:crypto";

import { notFound } from "../../../shared/domain/errors.js";
import { requireAppAdministration } from "../domain/authorization.js";
import { buildAppConnectionBinding } from "../domain/connectionBinding.js";
import { AppsError } from "../domain/errors.js";
import type { AppConnectionRecord } from "../domain/records.js";
import {
  assertExistingInstallationReleaseUsable,
  existingInstallationReleaseStates,
} from "../domain/releaseAdmission.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppSecretCipherPort } from "../ports/secretCipher.js";
import type { AppAuditIntent } from "../repositories/appAuditOutboxRepository.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "../repositories/appLifecycleOperationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";
import { appConnectionBindFingerprint } from "./appLifecycleFingerprint.js";

interface BindAppConnectionRequest {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly slotId: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly principal: AppOperatorPrincipal;
}

interface BindAppConnectionResult {
  readonly connection: AppConnectionRecord;
  /**
   * Present only on the response that mints it, and only for a `generated_secret` slot.
   * There is no read path that returns it again, and a replay does not mint a second one.
   */
  readonly generatedSecret: string | null;
  /** True when this answer came from a bind that had already happened under the same key. */
  readonly replayed: boolean;
}

interface AppConnectionServiceDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
  readonly unitOfWork: AppsUnitOfWork;
  readonly cipher: AppSecretCipherPort;
  readonly authorization: AppOperatorAuthorizationPort;
  /** The Radioso version this host runs, or `null` when it cannot be determined. */
  readonly runningRadiosoVersion: string | null;
  /** Delivers the audit intent this service commits. It never decides the response. */
  readonly auditDelivery: { drain(): Promise<number> };
}

/** Thrown inside the bind transaction when a concurrent retry claimed the key first. */
class ReplayRacedBind extends Error {
  constructor() {
    super("bind_replay");
  }
}

export class AppConnectionService {
  constructor(private readonly dependencies: AppConnectionServiceDependencies) {}

  /**
   * Write-only: values go in, an identifier and the slot's non-sensitive fields come out.
   *
   * Binding is a mutation of the installation, so it carries the version the operator
   * read, carries an idempotency key, and refuses while a lifecycle operation is
   * mid-flight. The version and the operation fence matter for the same reason: a bind
   * that lands during a removal would put live ciphertext back onto an installation whose
   * credentials were already marked for deletion. The key matters for a different one: a
   * host-minted secret is shown exactly once, so a retried request has to be answerable
   * without minting a second secret and orphaning the first.
   */
  async bind(request: BindAppConnectionRequest): Promise<BindAppConnectionResult> {
    await requireAppAdministration(this.dependencies.authorization, request.principal, request.workspaceId);

    const fingerprint = appConnectionBindFingerprint({
      workspaceId: request.workspaceId,
      installationId: request.installationId,
      slotId: request.slotId,
      expectedVersion: request.expectedVersion,
      valueKeys: Object.keys(request.values),
    });

    // Asked before anything is read or written, so a retry of a bind that succeeded is
    // answered by that bind rather than by a stale-version conflict.
    const replayed = await this.replayOf(request.workspaceId, request.idempotencyKey, fingerprint);
    if (replayed) return replayed;

    const installation = await this.dependencies.installations.findById(request.workspaceId, request.installationId);
    if (!installation) throw notFound("App installation not found");
    if (installation.state === "removing" || installation.state === "removed") {
      throw new AppsError("installation_removing", "This installation is being removed, so its connections cannot be changed.", {
        state: installation.state,
      });
    }

    const inFlight = await this.dependencies.operations.findActiveByInstallation(installation.id);
    if (inFlight) {
      throw new AppsError(
        "operation_in_progress",
        "A lifecycle operation is running for this installation, so its connections cannot be changed right now.",
        { operationId: inFlight.id, operationKind: inFlight.kind },
      );
    }

    const releaseId = installation.activeReleaseId ?? installation.candidateReleaseId;
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) throw notFound("App release not found");
    // Whether a field is sensitive is a rule, so it is read from the admitted manifest
    // rather than from whatever the release row happens to hold — and the release has to
    // still be one this host can act on, including on the version it runs today. A
    // deprecated release still binds: deprecation stops new installs, not the operator
    // finishing the setup of one they already have.
    const manifest = assertExistingInstallationReleaseUsable(release, this.dependencies.runningRadiosoVersion);

    const slot = manifest.connections.slots.find((candidate) => candidate.id === request.slotId);
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
    const secretCiphertext = binding.secret === null ? null : this.dependencies.cipher.encrypt(binding.secret);

    const connection = await this.dependencies.unitOfWork.run(async (repositories) => {
      // A revoked or quarantined release must not have credentials minted or stored for
      // it. Reading the release inside this transaction takes a share lock on it, so a
      // revocation racing this commit waits for it rather than landing in between.
      const eligible = await repositories.releases.lockEligible({
        releaseId: release.id,
        admissionPolicyVersion: release.admissionPolicyVersion,
        manifestDigest: release.manifestDigest,
        allowedStates: existingInstallationReleaseStates,
      });
      if (!eligible) {
        throw new AppsError(
          "release_not_eligible",
          "This release has been withdrawn from use, so its connections cannot be changed.",
          { releaseId: release.id },
        );
      }
      const claimed = await repositories.installations.update(
        request.workspaceId,
        installation.id,
        request.expectedVersion,
        {},
      );
      if (!claimed) {
        throw new AppsError("plan_stale", "This installation changed since it was read.", {
          cause: "version_mismatch",
        });
      }
      const bound = await repositories.connections.bind({
        installationId: installation.id,
        slotId: binding.slotId,
        kind: binding.kind,
        publicFields: binding.publicFields,
        secretCiphertext,
        encryptionKeyId: secretCiphertext === null ? null : this.dependencies.cipher.keyId,
      });
      // The reservation commits with the connection it names, so a replay finds either the
      // whole bind or none of it — never a claimed key with nothing behind it.
      const reserved = await repositories.connections.reserveBind({
        workspaceId: request.workspaceId,
        installationId: installation.id,
        connectionId: bound.id,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: fingerprint,
      });
      // Two retries raced. Everything above rolls back with this throw, so the loser mints
      // nothing and stores nothing, and reads the winner's answer outside the transaction.
      if (!reserved) throw new ReplayRacedBind();
      const intent: AppAuditIntent = {
        workspaceId: request.workspaceId,
        accountId: request.principal.accountId,
        eventType: existing ? "app.connection.rotated" : "app.connection.bound",
        eventStatus: "success",
        metadata: {
          installationId: installation.id,
          appId: installation.appId,
          connectionId: bound.id,
          slotId: bound.slotId,
          slotKind: bound.kind,
          actorUserId: request.principal.userId,
          // Field *names* the operator filled in. Never a value.
          publicFieldKeys: Object.keys(bound.publicFields),
          hasSecret: bound.hasSecret,
        },
      };
      await repositories.auditOutbox.enqueue([intent]);
      return bound;
    }).catch(async (error: unknown) => {
      if (!(error instanceof ReplayRacedBind)) throw error;
      const winner = await this.replayOf(request.workspaceId, request.idempotencyKey, fingerprint);
      if (!winner) throw error;
      return winner;
    });

    // The winner's answer, read after the loser rolled back. It has already been audited.
    if ("replayed" in connection) return connection;

    // The generated secret exists in exactly one response. Delivery of the audit record is
    // durable because its intent committed with the ciphertext, so a sink that is down can
    // never suppress the one handover the operator gets.
    await this.dependencies.auditDelivery.drain();

    return { connection, generatedSecret: binding.generatedSecret, replayed: false };
  }

  /**
   * The answer a completed bind already produced, or nothing. A matching fingerprint is
   * the same request; a different one is a key used for something else, and answering it
   * with this connection would report a bind that never happened.
   */
  private async replayOf(
    workspaceId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<BindAppConnectionResult | null> {
    const reservation = await this.dependencies.connections.findBindByIdempotencyKey(workspaceId, idempotencyKey);
    if (!reservation) return null;
    if (reservation.requestFingerprint !== fingerprint) {
      throw new AppsError(
        "idempotency_key_reused",
        "This idempotency key was already used for a different connection bind. Use a new key.",
        { connectionId: reservation.connectionId },
      );
    }
    const connection = await this.dependencies.connections.findById(reservation.connectionId);
    if (!connection) return null;
    // Never re-minted. The secret was handed over on the response that created it, and a
    // retry that produced a second one would leave the first stored somewhere unusable.
    return { connection, generatedSecret: null, replayed: true };
  }

  list(installationId: string): Promise<AppConnectionRecord[]> {
    return this.dependencies.connections.listByInstallation(installationId);
  }
}
