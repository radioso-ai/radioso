import { errorClassOf } from "../../../shared/observability/errorClass.js";
import { isMaintainedRuntime, type VoiceRuntimeBinding, type VoiceRuntimeConnectionStore } from "../domain.js";

/**
 * Whether a session may set what its vendor agent lets it: the first message and the language.
 * `unmaintained`: the bound vendor agent is not one Radioso keeps, so the session sets neither (the
 * vendor closes a session that sets an override its agent does not allow). `unknown`: the
 * connection could not be read, which leaves the same answer.
 */
export type SessionMaintenance =
  | { kind: "maintained" }
  | { kind: "unmaintained" }
  | { kind: "unknown"; errorClass: string };

/** Reads once whether Radioso maintains the session's bound vendor agent. Never rejects. */
export const readSessionMaintenance = async (
  connections: Pick<VoiceRuntimeConnectionStore, "find">,
  input: { workspaceId: string; agentId: string; runtime: VoiceRuntimeBinding },
): Promise<SessionMaintenance> => {
  try {
    const connection = await connections.find({ workspaceId: input.workspaceId, agentId: input.agentId });
    return isMaintainedRuntime(input.runtime, connection) ? { kind: "maintained" } : { kind: "unmaintained" };
  } catch (error) {
    return { kind: "unknown", errorClass: errorClassOf(error) };
  }
};

/** The work's value, or `timedOut` once `waitMs` passes first; a late rejection is the race's, never unhandled. */
export const withinWait = async <T>(work: Promise<T>, waitMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), waitMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
