const ALLOWED_MACHINE_ACCESS_AUDIT_KEYS = new Set([
  "actorUserId",
  "credentialId",
  "initialCredential",
  "principalId",
  "principalKind",
  "reason",
  "role",
  "roleCeiling",
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
