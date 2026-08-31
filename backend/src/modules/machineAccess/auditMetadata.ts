import { requestAuditMetadata } from "../../shared/observability/requestAuditContext.js";
import type { MachineAccessAuditEvent, TransactionalLifecycleAuditEvent } from "./ports.js";

const ALLOWED_MACHINE_ACCESS_AUDIT_KEYS = new Set([
  "actorUserId",
  "changed",
  "credentialId",
  "initialCredential",
  "principalId",
  "principalKind",
  "reason",
  "requestId",
  "role",
  "roleCeiling",
  "rotatedFromCredentialId",
  "status",
  "systemInitiated",
] as const);

/** Machine-access audit payloads intentionally admit identifiers and lifecycle facts only. */
export const machineAccessAuditMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => {
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_MACHINE_ACCESS_AUDIT_KEYS.has(key as never)) {
      throw new Error(`Unexpected machine-access audit metadata key: ${key}`);
    }
    if (/(?:secret|token|hash|authorization|ciphertext)/iu.test(key)) {
      throw new Error(`Secret-bearing machine-access audit metadata key: ${key}`);
    }
    if (typeof value === "string" && value.length > 200) {
      throw new Error(`Machine-access audit metadata value is too large: ${key}`);
    }
  }
  return metadata;
};

/** Mirrors AuditService.record attribution before the repository writes in-transaction. */
export const machineAccessAuditEvent = (event: MachineAccessAuditEvent): MachineAccessAuditEvent => ({
  ...event,
  metadata: machineAccessAuditMetadata({
    ...event.metadata,
    ...requestAuditMetadata(event.eventType),
  }),
});

/** Applies the same safe request correlation attribution as AuditService.record. */
export const transactionalLifecycleAuditEvent = (
  event: TransactionalLifecycleAuditEvent,
): TransactionalLifecycleAuditEvent => ({
  ...event,
  metadata: { ...event.metadata, ...requestAuditMetadata(event.eventType) },
});
