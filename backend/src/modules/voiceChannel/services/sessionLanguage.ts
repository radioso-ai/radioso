import { errorClassOf } from "../../../shared/observability/errorClass.js";
import {
  VoiceVendorRequestError,
  type VoiceRuntimeBinding,
  type VoiceSessionLanguage,
  type VoiceSessionLanguageSource,
  type VoiceVendorCredential,
} from "../domain.js";
import { withinWait, type SessionMaintenance } from "./sessionPreparation.js";

/** How a session's language came out: the closed values the start counts it by. */
export type SessionLanguageOutcome = VoiceSessionLanguage["outcome"] | "timed_out" | "failed";

type SessionLanguageFailure = { outcome: "failed"; errorClass: string; reason?: VoiceVendorRequestError["reason"]; vendorStatus?: number };

/**
 * What a session start learned for the call's language. `skipped`: the session sets none, because
 * Radioso does not maintain the bound vendor agent or could not tell (the first message's
 * preparation reports that read). `timed_out`: no answer within the wait. Otherwise the vendor's
 * answer, or why there is none, and how long it took (`durationMs`).
 */
export type SessionLanguagePreparation =
  | { outcome: "skipped" }
  | { outcome: "timed_out" }
  | ((VoiceSessionLanguage | SessionLanguageFailure) & { durationMs: number });

interface SessionLanguageDependencies {
  languages: VoiceSessionLanguageSource;
  /** How long the vendor's answer may take before the call starts without a language. */
  waitMs: number;
  now: () => number;
}

const failureOf = (error: unknown): SessionLanguageFailure => ({
  outcome: "failed",
  errorClass: errorClassOf(error),
  ...(error instanceof VoiceVendorRequestError ? { reason: error.reason } : {}),
  ...(error instanceof VoiceVendorRequestError && error.vendorStatus !== undefined ? { vendorStatus: error.vendorStatus } : {}),
});

/**
 * Reads the language a session on a vendor agent Radioso maintains starts in: the vendor's code for
 * the session's language tag, when the vendor agent does not start in it already, lets a session
 * set it and can speak it, asked within `waitMs`. A vendor agent set up before it allowed that
 * reads `not_allowed` until Connect or a default-locale sync sets it up again, so no session sets a
 * language the vendor would close it for. The read is stopped once the wait passes or `signal`
 * aborts (the start failed), so it never outlives what the start waits for. Never rejects.
 */
export const prepareSessionLanguage = async (
  dependencies: SessionLanguageDependencies,
  input: {
    maintenance: SessionMaintenance;
    runtime: VoiceRuntimeBinding;
    credential: VoiceVendorCredential;
    locale: string;
    signal: AbortSignal;
  },
): Promise<SessionLanguagePreparation> => {
  if (input.maintenance.kind !== "maintained") return { outcome: "skipped" };
  const { runtime, credential, locale } = input;
  const deadline = new AbortController();
  const signal = AbortSignal.any([input.signal, deadline.signal]);
  const startedAt = dependencies.now();
  const answered = (answer: VoiceSessionLanguage | SessionLanguageFailure): SessionLanguagePreparation =>
    ({ ...answer, durationMs: dependencies.now() - startedAt });
  try {
    const read = await withinWait(
      dependencies.languages.languageFor({ region: runtime.region, credential, vendorAgentId: runtime.agentId, locale, signal }),
      dependencies.waitMs,
    );
    if (!read.timedOut) return answered(read.value);
    deadline.abort();
    return { outcome: "timed_out" };
  } catch (error) {
    return answered(failureOf(error));
  }
};

/** The vendor's code for the language the session sets, when it sets one. */
export const languageToSet = (preparation: SessionLanguagePreparation): string | null =>
  preparation.outcome === "set" ? preparation.language : null;
