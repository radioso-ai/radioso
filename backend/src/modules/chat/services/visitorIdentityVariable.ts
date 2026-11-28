import type { ResolvedVariableInput } from "../../context-variables/public.js";

/** The resolved host variables, with the verified identity a signed token supplied on this turn. */
export const withVisitorIdentity = (
  resolved: ResolvedVariableInput[],
  verifiedIdentity: Record<string, unknown> | null | undefined,
): ResolvedVariableInput[] => verifiedIdentity
  ? [...resolved, {
      name: "visitor_identity",
      description: "Verified visitor identity supplied by the host.",
      value: verifiedIdentity,
      surfacing: "on_reference",
      sensitive: true,
      trust: "verified",
    }]
  : resolved;
