/**
 * Typed values for the outbound headers Radioso composes itself: Message-IDs (`Message-ID`,
 * `In-Reply-To`, `References`), addresses and the `From` mailbox. Validation is structural only
 * (RFC 5322 shape); it never judges what a value means.
 *
 * Every constructor rejects a value that could end a header line or smuggle in another address,
 * so a typed value is safe to place in a header as is. Errors name the field and the reason but
 * never echo the value: rejected values are addresses and thread tokens (FR-045).
 */

export type RfcMessageId = string & { readonly __brand: "RfcMessageId" };
export type HeaderSafeAddress = string & { readonly __brand: "HeaderSafeAddress" };

type EmailHeaderField = "message_id" | "address" | "display_name";

type EmailHeaderValueRejection =
  | "line_break"
  | "control_character"
  | "whitespace"
  | "missing_angle_brackets"
  | "angle_brackets"
  | "malformed";

export class EmailHeaderValueError extends Error {
  constructor(
    readonly field: EmailHeaderField,
    readonly reason: EmailHeaderValueRejection,
  ) {
    super(`Invalid ${field} header value: ${reason}`);
    this.name = "EmailHeaderValueError";
  }
}

/** CR, LF and the Unicode line and paragraph separators, any of which can end a header line. */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const WHITESPACE = /\s/u;

/** RFC 5322 `atext`, plus the dot that `dot-atom-text` allows between atoms. */
const ATEXT_OR_DOT = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~.]+";
const DOMAIN_LITERAL = "\\[[\\x21-\\x5a\\x5e-\\x7e]*\\]";
const MESSAGE_ID = new RegExp(`^<${ATEXT_OR_DOT}@(?:${ATEXT_OR_DOT}|${DOMAIN_LITERAL})>$`);
/** RFC 5322's 998-character line limit bounds a single header value. */
const MAX_MESSAGE_ID_LENGTH = 998;

const ADDRESS_LOCAL_PART = /^[^\s\p{Cc}<>@,;:"()[\]\\]+$/u;
const DOMAIN_LABEL = "[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?";
const ADDRESS_DOMAIN = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`, "u");
/** RFC 5321's forward-path limit. */
const MAX_ADDRESS_LENGTH = 254;

/** RFC 5322 `specials`: a display name containing one must be a quoted string. */
const DISPLAY_NAME_SPECIALS = /[()[\]:;@\\,."]/u;
const DISPLAY_NAME_ANGLE_BRACKETS = /[<>]/u;

const rejectLineBreaksAndControls = (field: EmailHeaderField, value: string): void => {
  if (LINE_BREAK.test(value)) {
    throw new EmailHeaderValueError(field, "line_break");
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new EmailHeaderValueError(field, "control_character");
  }
};

/** Throws `EmailHeaderValueError` unless `value` is exactly one `<id-left@id-right>`. */
export const rfcMessageId = (value: string): RfcMessageId => {
  rejectLineBreaksAndControls("message_id", value);
  if (WHITESPACE.test(value)) {
    throw new EmailHeaderValueError("message_id", "whitespace");
  }
  if (!value.startsWith("<") || !value.endsWith(">")) {
    throw new EmailHeaderValueError("message_id", "missing_angle_brackets");
  }
  if (value.length > MAX_MESSAGE_ID_LENGTH || !MESSAGE_ID.test(value)) {
    throw new EmailHeaderValueError("message_id", "malformed");
  }
  return value as RfcMessageId;
};

/** The typed id, or null for a value `rfcMessageId` would reject. For ids a provider or peer supplied. */
export const parseRfcMessageId = (value: string): RfcMessageId | null => {
  try {
    return rfcMessageId(value);
  } catch (error) {
    if (error instanceof EmailHeaderValueError) {
      return null;
    }
    throw error;
  }
};

/** Throws `EmailHeaderValueError` unless `value` is one bare `local@domain` address. */
export const headerSafeAddress = (value: string): HeaderSafeAddress => {
  rejectLineBreaksAndControls("address", value);
  if (WHITESPACE.test(value)) {
    throw new EmailHeaderValueError("address", "whitespace");
  }
  const separator = value.indexOf("@");
  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    separator < 0
    || value.length > MAX_ADDRESS_LENGTH
    || !ADDRESS_LOCAL_PART.test(localPart)
    || !ADDRESS_DOMAIN.test(domain)
  ) {
    throw new EmailHeaderValueError("address", "malformed");
  }
  return value as HeaderSafeAddress;
};

/**
 * The `From`-style mailbox `Name <address>`, or the bare address when there is no name. A name
 * with RFC 5322 specials is quoted so it cannot split into a second mailbox. Throws
 * `EmailHeaderValueError` for an unsafe address, or a name that could end the header line or
 * spell out an address of its own.
 */
export const formatMailbox = (mailbox: { email: string; name?: string | null }): string => {
  const address = headerSafeAddress(mailbox.email);
  const name = mailbox.name;
  if (!name) {
    return address;
  }
  rejectLineBreaksAndControls("display_name", name);
  if (DISPLAY_NAME_ANGLE_BRACKETS.test(name)) {
    throw new EmailHeaderValueError("display_name", "angle_brackets");
  }
  return `${DISPLAY_NAME_SPECIALS.test(name) ? quoted(name) : name} <${address}>`;
};

const quoted = (name: string): string => `"${name.replace(/["\\]/gu, (special) => `\\${special}`)}"`;
