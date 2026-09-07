import type { ConnectionSlot } from "@radioso/app-contract";

import { AppsError } from "./errors.js";

export const appConnectionKinds = ["secret_fields", "generated_secret"] as const;
export type AppConnectionKind = (typeof appConnectionKinds)[number];

interface AppConnectionBindingInput {
  readonly slot: ConnectionSlot;
  readonly values: Readonly<Record<string, unknown>>;
  /** Host-side entropy for a `generated_secret` slot. */
  readonly generateSecret: (byteLength: number) => string;
}

interface AppConnectionBindingResult {
  readonly slotId: string;
  readonly kind: AppConnectionKind;
  /** Safe to return, log, and show: the slot's non-sensitive fields only. */
  readonly publicFields: Readonly<Record<string, string>>;
  /** Goes straight to the cipher. Never returned, logged, or audited. */
  readonly secret: string | null;
  /** Non-null exactly once, on the response that mints it. */
  readonly generatedSecret: string | null;
}

const invalid = (message: string, slotId: string): AppsError =>
  new AppsError("connection_invalid", message, { slotId });

/**
 * Splits a submitted binding into what an operator may read back and what only the
 * cipher may see. A `generated_secret` slot ignores whatever was submitted: the host
 * mints the value, which is the whole point of the kind.
 */
export const buildAppConnectionBinding = (input: AppConnectionBindingInput): AppConnectionBindingResult => {
  const slot = input.slot;
  if (slot.kind === "oauth2") {
    throw new AppsError("connection_invalid", "Authorization-code connections are not available yet.", { slotId: slot.id });
  }

  if (slot.kind === "generated_secret") {
    const secret = input.generateSecret(slot.byteLength);
    return { slotId: slot.id, kind: "generated_secret", publicFields: {}, secret, generatedSecret: secret };
  }

  const declared = new Set(slot.fields.map((field) => field.key));
  for (const key of Object.keys(input.values)) {
    if (!declared.has(key)) throw invalid(`${key} is not a field of this connection.`, slot.id);
  }

  const publicFields: Record<string, string> = {};
  const sensitive: Record<string, string> = {};
  for (const field of slot.fields) {
    const value = input.values[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) throw invalid(`${field.label} is required.`, slot.id);
      continue;
    }
    if (typeof value !== "string") throw invalid(`${field.label} must be text.`, slot.id);
    if (field.sensitive) sensitive[field.key] = value;
    else publicFields[field.key] = value;
  }

  return {
    slotId: slot.id,
    kind: "secret_fields",
    publicFields,
    secret: Object.keys(sensitive).length > 0 ? JSON.stringify(sensitive) : null,
    generatedSecret: null,
  };
};
