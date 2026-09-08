import type { AppManifest } from "@radioso/app-contract";

import type { AppConnectionKind } from "./connectionBinding.js";
import type { AppGrantKind, AppInstallationPlan } from "./installationPlan.js";
import type {
  AppInstallationState,
  AppLifecycleOperationKind,
  AppLifecycleOperationState,
  AppSagaStepId,
} from "./lifecycle.js";
import type { AppOperatorPrincipal } from "../ports/operatorAuthorization.js";

export const appReleaseStates = [
  "submitted",
  "validating",
  "admitted",
  "rejected",
  "withdrawn",
  "deprecated",
  "revoked",
  "quarantined",
] as const;
export type AppReleaseState = (typeof appReleaseStates)[number];

export interface AppReleaseRecord {
  readonly id: string;
  readonly appId: string;
  readonly version: string;
  readonly manifest: AppManifest;
  readonly manifestDigest: string;
  readonly artifactDigest: string;
  readonly publisherId: string;
  readonly state: AppReleaseState;
  readonly admissionPolicyVersion: string;
  /** Issue list or evidence summary. Never a copy of the manifest. */
  readonly admissionDecision: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AppInstallationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly appId: string;
  readonly activeReleaseId: string | null;
  readonly candidateReleaseId: string | null;
  readonly state: AppInstallationState;
  readonly configuration: Readonly<Record<string, unknown>>;
  /** What a reconfigure proposes, staged beside the configuration still in use. */
  readonly candidateConfiguration: Readonly<Record<string, unknown>> | null;
  /** Names the staged candidate so staging can discard exactly the one it was given. */
  readonly candidateRevision: string | null;
  /** Set the moment a disable or a remove is claimed. Execution eligibility denies while it is set. */
  readonly executionDeniedAt: Date | null;
  readonly version: number;
  readonly health: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AppInstallationPlanRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly releaseId: string;
  readonly checksum: string;
  readonly plan: AppInstallationPlan;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface AppGrantRecord {
  readonly id: string;
  readonly installationId: string;
  readonly releaseId: string;
  readonly kind: AppGrantKind;
  readonly key: string;
  readonly planId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date;
  readonly revokedAt: Date | null;
}

export interface AppConnectionRecord {
  readonly id: string;
  readonly installationId: string;
  readonly slotId: string;
  readonly kind: AppConnectionKind;
  readonly publicFields: Readonly<Record<string, string>>;
  /** True when secret material is stored. The ciphertext itself never leaves persistence. */
  readonly hasSecret: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly rotatedAt: Date | null;
  readonly deletionRequestedAt: Date | null;
}

export interface AppLifecycleOperationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly kind: AppLifecycleOperationKind;
  readonly state: AppLifecycleOperationState;
  readonly step: AppSagaStepId | null;
  /** Where a reverse runner has got to. `null` means no compensator has completed. */
  readonly compensationStep: AppSagaStepId | null;
  /** The driver that currently owns the next step, and when its claim lapses. */
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly idempotencyKey: string;
  /**
   * A digest of what the request asked for. The same key with the same fingerprint is a
   * retry and replays; the same key with a different fingerprint is a mistake, and
   * answering it with the earlier operation would report success for work never done.
   */
  readonly requestFingerprint: string;
  readonly initiatedBy: AppOperatorPrincipal;
  readonly payload: Readonly<Record<string, unknown>>;
  /** A reason code and a static message. Never an adapter's own exception text. */
  readonly error: { readonly reason: string; readonly message: string } | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
