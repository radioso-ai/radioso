import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { VoiceGreetingSource } from "../domain.js";
import { withinWait, type SessionMaintenance } from "./sessionPreparation.js";
import { hasSpokenWords, spokenText } from "./speechText.js";

/** How the greeting a call opens with came out: the closed values the start counts it by. */
export type SessionGreetingOutcome = "spoken" | "none" | "timed_out" | "failed";

/**
 * What a session start learned for the call's first message: on a vendor agent Radioso maintains,
 * the greeting as words to say, or why there is none; otherwise why the session may set none (see
 * `SessionMaintenance`).
 */
export type SessionFirstMessagePreparation =
  | Exclude<SessionMaintenance, { kind: "maintained" }>
  | { kind: "maintained"; durationMs: number; greeting: SessionGreeting };

type SessionGreeting =
  | { outcome: "spoken"; text: string }
  | { outcome: "none" }
  | { outcome: "timed_out" }
  | { outcome: "failed"; errorClass: string };

interface SessionFirstMessageDependencies {
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

/**
 * Reads what a session's first message needs: on a vendor agent Radioso maintains, the agent's
 * greeting in the session's language, within `waitMs`. A greeting still being generated when the
 * wait ends finishes on its own and is cached for the next call. Never rejects.
 */
export const prepareSessionFirstMessage = async (
  dependencies: SessionFirstMessageDependencies,
  input: { maintenance: SessionMaintenance; workspaceId: string; agentId: string; locale: string | null },
): Promise<SessionFirstMessagePreparation> => {
  const { maintenance, workspaceId, agentId } = input;
  if (maintenance.kind !== "maintained") return maintenance;
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
