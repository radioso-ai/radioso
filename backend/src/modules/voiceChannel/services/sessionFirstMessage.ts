import { errorClassOf } from "../../../shared/observability/errorClass.js";
import {
  isMaintainedRuntime,
  type VoiceGreetingSource,
  type VoiceRuntimeBinding,
  type VoiceRuntimeConnectionStore,
} from "../domain.js";
import { hasSpokenWords, spokenText } from "./speechText.js";

/** How the greeting a call opens with came out: the closed values the start counts it by. */
export type SessionGreetingOutcome = "spoken" | "none" | "timed_out" | "failed";

/**
 * What a session start learned for the call's first message. `unmaintained`: the bound vendor agent
 * is not one Radioso keeps, so the session may set no first message (the vendor closes a session
 * that sets one its agent does not allow). `unknown`: the connection could not be read, which
 * leaves the same answer. `maintained`: the greeting as words to say (null when there are none),
 * or why there is none.
 */
export type SessionFirstMessagePreparation =
  | { kind: "unmaintained" }
  | { kind: "unknown"; errorClass: string }
  | { kind: "maintained"; durationMs: number; greeting: SessionGreeting };

type SessionGreeting =
  | { outcome: "spoken"; text: string }
  | { outcome: "none" }
  | { outcome: "timed_out" }
  | { outcome: "failed"; errorClass: string };

interface SessionFirstMessageDependencies {
  connections: Pick<VoiceRuntimeConnectionStore, "find">;
  greetings: VoiceGreetingSource;
  /** How long the greeting may take before the call starts without it. */
  waitMs: number;
  now: () => number;
}

/** Text as a caller hears it, markdown and citation markers removed by structure; null when nothing in it is said. */
const asSpeech = (text: string | null): string | null => {
  const said = text === null ? "" : spokenText(text).trim();
  return said.length > 0 && hasSpokenWords(said) ? said : null;
};

/** The work's value, or `timedOut` once `waitMs` passes first; a late rejection is the race's, never unhandled. */
const withinWait = async <T>(work: Promise<T>, waitMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
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

/**
 * Reads what a session's first message needs: whether Radioso maintains the bound vendor agent,
 * and on one it does, the agent's greeting in the session's language, within `waitMs`. A greeting
 * still being generated when the wait ends finishes on its own and is cached for the next call.
 * Never rejects.
 */
export const prepareSessionFirstMessage = async (
  dependencies: SessionFirstMessageDependencies,
  input: { workspaceId: string; agentId: string; runtime: VoiceRuntimeBinding; locale: string | null },
): Promise<SessionFirstMessagePreparation> => {
  const { workspaceId, agentId } = input;
  try {
    const connection = await dependencies.connections.find({ workspaceId, agentId });
    if (!isMaintainedRuntime(input.runtime, connection)) return { kind: "unmaintained" };
  } catch (error) {
    return { kind: "unknown", errorClass: errorClassOf(error) };
  }
  const startedAt = dependencies.now();
  const greeting = await readGreeting(dependencies, { workspaceId, agentId, locale: input.locale });
  return { kind: "maintained", durationMs: dependencies.now() - startedAt, greeting };
};

const readGreeting = async (
  dependencies: SessionFirstMessageDependencies,
  input: { workspaceId: string; agentId: string; locale: string | null },
): Promise<SessionGreeting> => {
  try {
    const read = await withinWait(dependencies.greetings.greetingFor(input), dependencies.waitMs);
    if (read.timedOut) return { outcome: "timed_out" };
    const text = asSpeech(read.value);
    return text === null ? { outcome: "none" } : { outcome: "spoken", text };
  } catch (error) {
    return { outcome: "failed", errorClass: errorClassOf(error) };
  }
};

/**
 * What the call says first: the recording notice, then the greeting, each as a caller hears it,
 * a paragraph apart. Null when the session may set no first message, or there is nothing to say.
 */
export const firstMessageOf = (preparation: SessionFirstMessagePreparation, recordingNotice: string | null): string | null => {
  if (preparation.kind !== "maintained") return null;
  const greeting = preparation.greeting.outcome === "spoken" ? preparation.greeting.text : null;
  const parts = [asSpeech(recordingNotice), greeting].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("\n\n") : null;
};
