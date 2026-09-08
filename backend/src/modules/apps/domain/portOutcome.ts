import { AppsError, type AppsErrorReason } from "./errors.js";

/**
 * How an App lifecycle port reports failure. The set is closed on purpose: an adapter
 * talks to a container runtime, a staging projection, or a disposition job, and any of
 * those can put a token, a connection string, or a request body into an exception
 * message. The control plane persists and presents the code, never an adapter's own
 * text, so a diagnostic can never become a disclosure.
 */
export const appPortFailureCodes = [
  "runtime_unavailable",
  "runtime_provision_failed",
  "runtime_deprovision_failed",
  "contribution_staging_failed",
  "safe_test_failed",
  "contribution_detach_failed",
  "data_disposition_failed",
  /** An adapter threw instead of answering. The thrown value is never read for text. */
  "adapter_error",
] as const;
export type AppPortFailureCode = (typeof appPortFailureCodes)[number];

/** Bounded, vetted, operator-safe text. Logged; never persisted, audited, or returned. */
const APP_PORT_DETAIL_MAX_LENGTH = 200;

interface AppPortFailure {
  readonly ok: false;
  readonly code: AppPortFailureCode;
  readonly detail?: string;
}

export type AppPortResult = { readonly ok: true } | AppPortFailure;

/**
 * The one way to build a port refusal, so the detail bound holds wherever a refusal is
 * made rather than only where it is written down.
 */
export const appPortFailure = (code: AppPortFailureCode, detail?: string): AppPortFailure => ({
  ok: false,
  code,
  ...(detail === undefined ? {} : { detail: detail.slice(0, APP_PORT_DETAIL_MAX_LENGTH) }),
});

interface AppPortFailureMeaning {
  readonly reason: AppsErrorReason;
  /** Static, written here. Never assembled from anything an adapter produced. */
  readonly message: string;
}

const failureMeanings: Readonly<Record<AppPortFailureCode, AppPortFailureMeaning>> = {
  runtime_unavailable: {
    reason: "runtime_unavailable",
    message: "No App runtime provider is configured, so this installation cannot run. Configure a runtime provider and retry.",
  },
  runtime_provision_failed: {
    reason: "runtime_unavailable",
    message: "The App runtime provider could not start this installation. Check the runtime provider and retry.",
  },
  runtime_deprovision_failed: {
    reason: "runtime_unavailable",
    message: "The App runtime provider could not stop this installation. Check the runtime provider and retry.",
  },
  contribution_staging_failed: {
    reason: "staging_unavailable",
    message: "This release's contributions could not be staged. Retry the operation.",
  },
  safe_test_failed: {
    reason: "safe_test_failed",
    message: "The safe test did not pass for this release, so it was not activated.",
  },
  contribution_detach_failed: {
    reason: "staging_unavailable",
    message: "This installation's contributions could not be detached. Retry the operation.",
  },
  data_disposition_failed: {
    reason: "data_disposition_unavailable",
    message: "This installation's managed data could not be disposed of. Retry the operation.",
  },
  adapter_error: {
    reason: "runtime_unavailable",
    message: "An App platform adapter failed. Retry the operation, and check the platform logs for the failing step.",
  },
};

/** Turns a port refusal into the one typed, secret-safe failure the control plane records. */
export const appPortFailureAsError = (
  code: AppPortFailureCode,
  details?: Readonly<Record<string, string | number>>,
): AppsError => {
  const meaning = failureMeanings[code];
  return new AppsError(meaning.reason, meaning.message, { ...details, code });
};
