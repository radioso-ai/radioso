import { domainToUnicode } from "node:url";

import type { LinkDestinationPolicy, LinkDestinationVerdict } from "./markdownLinkGuard.js";

/** Why a link destination is not one of the given addresses. */
export type UnwrappedLinkReason = "fragment" | "relative" | "malformed" | "not_given";

const KEEP: LinkDestinationVerdict<UnwrappedLinkReason> = { kind: "keep" };
const unwrap = (reason: UnwrappedLinkReason): LinkDestinationVerdict<UnwrappedLinkReason> => ({ kind: "unwrap", reason });

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const WEB_SCHEME_PREFIX = /^https?:\/\//;
const WHITESPACE = /\s/;
// Characters a host or path segment continues with; an address that runs on into one of
// them is a different address.
const ADDRESS_CHAR = /[\p{L}\p{N}\-_~%+]/u;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
// What may not precede a host: a character that extends it, so `school.example` is found
// after `://` or a space, never inside `myschool.example` or `shop.school.example`. An `@`
// makes it an email domain, which names a mailbox, not a website.
const HOST_CHAR = /[\p{L}\p{N}\-_.@]/u;
const EMAIL_CHAR = /[\p{L}\p{N}._%+-]/u;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const PERCENT_ENCODED_RUN = /(?:%[0-9a-f]{2})+/gi;
const PHONE_RUN = /\+?\d(?:[\d \t\u00a0()./-]*\d)?/g;
const MIN_PHONE_DIGITS = 6;

const decodePercentRuns = (text: string): string =>
  text.replace(PERCENT_ENCODED_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

/** `host/path?query` of a web address: lower case, no scheme, `www.`, fragment, or trailing `/`. */
const webAddressKey = (address: string): string =>
  address
    .toLowerCase()
    .replace(WEB_SCHEME_PREFIX, "")
    .replace(/^www\./, "")
    .split("#")[0]
    .replace(TRAILING_PUNCTUATION, "")
    .replace(/\/+$/, "")
    .replace(TRAILING_PUNCTUATION, "");

const endsAddress = (text: string, end: number): boolean => {
  const next = text[end];
  if (next === undefined) {
    return true;
  }
  if (next === ".") {
    return !ALPHANUMERIC.test(text[end + 1] ?? "");
  }
  return !ADDRESS_CHAR.test(next);
};

const startsHost = (text: string, start: number): boolean => {
  const previous = text[start - 1];
  if (previous === undefined || !HOST_CHAR.test(previous)) {
    return true;
  }
  return text.slice(start - 4, start) === "www." && !HOST_CHAR.test(text[start - 5] ?? "");
};

const startsEmail = (text: string, start: number): boolean => !EMAIL_CHAR.test(text[start - 1] ?? "");

const occurs = (text: string, key: string, startsAt: (text: string, start: number) => boolean): boolean => {
  for (let index = text.indexOf(key); index >= 0; index = text.indexOf(key, index + 1)) {
    if (startsAt(text, index) && endsAddress(text, index + key.length)) {
      return true;
    }
  }
  return false;
};

/**
 * Whether a link destination is an address some given text holds.
 *
 * It knows URL forms and how one address is written several ways, and nothing about where
 * the given text came from or how a link is spelled in Markdown. A web address counts as
 * given when the given text names it, or names an address it is the home page or a parent
 * path of: the scheme, `www.`, host case, a trailing slash, trailing punctuation, a fragment,
 * percent-encoding, and an internationalised host may each differ. A query must be given as
 * written or left off. An email or phone address counts when the given text holds it. A
 * fragment, a relative path, or a destination that is not one address never names a page a
 * reader can open, so it is never given.
 *
 * Matching errs toward keeping: unwrapping a real link breaks a good answer, while the cost
 * of keeping a near-miss is a link to a page of a site the reader was already pointed at.
 */
class GivenLinkTargets {
  private readonly text: string;
  private decodedText: string | undefined;
  private phoneDigits: string[] | undefined;

  /** `given`: every text the author of the links was given, in any order. */
  constructor(given: readonly string[]) {
    this.text = given.join("\n").toLowerCase();
  }

  verdictFor(destination: string): LinkDestinationVerdict<UnwrappedLinkReason> {
    const address = destination.trim();
    if (!address || WHITESPACE.test(address)) {
      return unwrap("malformed");
    }
    if (address.startsWith("#")) {
      return unwrap("fragment");
    }
    const scheme = SCHEME.exec(address)?.[1].toLowerCase();
    if (!scheme) {
      return unwrap("relative");
    }
    switch (scheme) {
      case "http":
      case "https":
        return this.webVerdict(address);
      case "mailto":
        return this.emailVerdict(address.slice("mailto:".length));
      case "tel":
        return this.phoneVerdict(address.slice("tel:".length));
      default:
        return this.verbatimVerdict(address);
    }
  }

  /** The given text as written, and with percent-encoding and `&amp;` decoded when that differs. */
  private texts(): string[] {
    this.decodedText ??= decodePercentRuns(this.text).replace(/&amp;/g, "&");
    return this.decodedText === this.text ? [this.text] : [this.text, this.decodedText];
  }

  private verbatimVerdict(address: string): LinkDestinationVerdict<UnwrappedLinkReason> {
    return this.texts().some((text) => text.includes(address.toLowerCase())) ? KEEP : unwrap("not_given");
  }

  private webVerdict(address: string): LinkDestinationVerdict<UnwrappedLinkReason> {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return unwrap("malformed");
    }
    if (!url.hostname) {
      return unwrap("malformed");
    }
    // A host with no dot (`localhost`, a page name read as a host) is a word as well as a host,
    // so only the whole address as written counts for it.
    if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) {
      return this.verbatimVerdict(address);
    }
    const parsedPath = `${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}`;
    const keys = new Set(
      [address, `${url.hostname}${parsedPath}`, `${domainToUnicode(url.hostname)}${parsedPath}`]
        .map(webAddressKey)
        .flatMap((key) => [key, decodePercentRuns(key)])
        .filter((key) => key.length > 0),
    );
    return this.texts().some((text) => [...keys].some((key) => occurs(text, key, startsHost)))
      ? KEEP
      : unwrap("not_given");
  }

  private emailVerdict(target: string): LinkDestinationVerdict<UnwrappedLinkReason> {
    const addresses = decodePercentRuns(target.split("?")[0])
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter((address) => address.length > 0);
    if (addresses.length === 0) {
      return unwrap("malformed");
    }
    const given = addresses.every((address) => this.texts().some((text) => occurs(text, address, startsEmail)));
    return given ? KEEP : unwrap("not_given");
  }

  private phoneVerdict(target: string): LinkDestinationVerdict<UnwrappedLinkReason> {
    const digits = target.replace(/\D/g, "");
    if (digits.length < MIN_PHONE_DIGITS) {
      return unwrap("malformed");
    }
    this.phoneDigits ??= [...this.text.matchAll(PHONE_RUN)]
      .map((run) => run[0].replace(/\D/g, ""))
      .filter((run) => run.length >= MIN_PHONE_DIGITS);
    // The same number with or without its country code or trunk prefix.
    const given = this.phoneDigits.some((run) => run.includes(digits) || digits.endsWith(run));
    return given ? KEEP : unwrap("not_given");
  }
}

/** The link policy for text whose author was given `given`: every text it read, in any order. */
export const givenLinkPolicy = (given: readonly string[]): LinkDestinationPolicy<UnwrappedLinkReason> => {
  const targets = new GivenLinkTargets(given);
  return (destination) => targets.verdictFor(destination);
};
