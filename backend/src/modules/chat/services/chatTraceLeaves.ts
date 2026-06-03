import type { CapabilitySubTrace } from "@radioso/conversation-contract";

/**
 * Capability trace-leaf identities for the chat turn. Each capability owns its
 * own leaf payload version; the frontend renderer registry keys on `namespace`.
 * Both retrieval and skill-intake currently carry an `ActivityTrace` payload, so
 * the frontend maps both namespaces to the shared activity-trace leaf renderer.
 */
export const RETRIEVAL_TRACE_LEAF = { namespace: "retrieval", version: 1 } as const;
export const SKILL_INTAKE_TRACE_LEAF = { namespace: "skill-intake", version: 1 } as const;

export const capabilitySubTrace = (
  leaf: { namespace: string; version: number },
  payload: unknown,
): CapabilitySubTrace => ({
  namespace: leaf.namespace,
  version: leaf.version,
  payload,
});
