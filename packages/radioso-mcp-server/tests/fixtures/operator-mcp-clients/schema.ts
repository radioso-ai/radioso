import { z } from "zod";

const nonEmpty = z.string().min(1).max(256);
const requiredVerifiedOperations = ["discovery", "callback", "list", "call", "refresh", "revoke"] as const;
const forbiddenArtifact = /(bearer\s+[a-z0-9._~-]+|(?:access|refresh)[_-]?token\s*[:=]|client[_-]?secret\s*[:=]|authorization\s*:\s*bearer|(?:api[_-]?key|password|credential)\s*[:=])/iu;

const containsCredentialArtifact = (value: unknown, path: string[] = []): string | null => {
  if (typeof value === "string") return forbiddenArtifact.test(value) ? path.join(".") || "value" : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsCredentialArtifact(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/(?:access|refresh)[_-]?token|client[_-]?secret|password|credential/iu.test(key)) return [...path, key].join(".");
      const found = containsCredentialArtifact(child, [...path, key]);
      if (found) return found;
    }
  }
  return null;
};

export const OperatorClientFixtureSchema = z.object({
  displayName: nonEmpty,
  clientSurface: nonEmpty,
  supportedBuild: nonEmpty,
  handoff: z.literal("remote-http-oauth-discovery"),
  resourceInsertion: z.literal("explicit-canonical-resource"),
  clientIdentification: z.literal("client-id-metadata-document"),
  redirectMechanism: nonEmpty,
  availability: z.enum(["available", "unavailable"]),
  verified: z.boolean(),
  exactBuildEvidenceRef: nonEmpty.optional(),
  operations: z.array(nonEmpty).min(1).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  failureRecovery: nonEmpty,
}).strict().superRefine((fixture, context) => {
  if (fixture.verified && (!fixture.exactBuildEvidenceRef || !fixture.operations || fixture.operations.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Verified fixtures require exact-build evidence and operations." });
  }
  if (fixture.verified && !requiredVerifiedOperations.every((operation) => fixture.operations?.includes(operation))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Verified fixtures require discovery, callback, list, call, refresh, and revoke operations." });
  }
  if (fixture.verified && fixture.availability !== "available") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Verified fixtures must be available." });
  }
  if (!fixture.verified && fixture.availability !== "unavailable") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Unverified fixtures must be unavailable." });
  }
  const artifactPath = containsCredentialArtifact(fixture);
  if (artifactPath) context.addIssue({ code: z.ZodIssueCode.custom, message: `Credential artifact at ${artifactPath}.` });
});
