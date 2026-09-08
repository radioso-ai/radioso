import { canonicalDigest } from "../domain/canonicalJson.js";
import type { AppLifecycleOperationKind } from "../domain/lifecycle.js";

interface AppLifecycleRequestFingerprintInput {
  readonly workspaceId: string;
  /** `null` on an apply, whose installation does not exist until the request succeeds. */
  readonly installationId: string | null;
  readonly kind: AppLifecycleOperationKind;
  /**
   * `null` outside an apply. Two plans can describe identical content and produce the same
   * checksum, so only the id says which approval, and whose provenance, this apply is for.
   */
  readonly planId: string | null;
  readonly planChecksum: string | null;
  readonly disposition: string | null;
  readonly configuration: Readonly<Record<string, unknown>> | null;
  readonly expectedVersion: number | null;
}

/**
 * What the request asked for, reduced to a comparable value. An idempotency key answers
 * "is this the same attempt"; the fingerprint answers "at the same thing". Without it, a
 * disable key reused for a remove replays the disable and reports success for a removal
 * that never happened.
 */
export const appLifecycleRequestFingerprint = (
  input: AppLifecycleRequestFingerprintInput,
): string => canonicalDigest({
  workspaceId: input.workspaceId,
  installationId: input.installationId,
  kind: input.kind,
  planId: input.planId,
  planChecksum: input.planChecksum,
  disposition: input.disposition,
  configuration: input.configuration,
  expectedVersion: input.expectedVersion,
});
