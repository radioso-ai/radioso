import { createHash } from "node:crypto";
import { z } from "zod";

import { badRequest } from "../../shared/domain/errors.js";
import { isLocaleTag } from "../../shared/domain/locale.js";

/**
 * The agent's privacy notice: one operator-authored line and a link to the operator's policy, per
 * language, shown to a visitor before their first message and sent with the first reply of an
 * email conversation. It informs; it asks nothing of the visitor, so it is not consent.
 *
 * Each notice carries a version, derived from its language, line and link, so the same notice has
 * the same version on every save, in every region and after an agent bundle import, and a notice
 * whose words or link change gets a new one. A conversation records the version its visitor was
 * shown; whoever holds the published line and link can recompute it.
 */
export interface AgentPrivacyNotice {
  text: string;
  url: string;
  /** `<language tag>:<16 hex>`; never authored, recomputed on every read and write. */
  version: string;
}

export type AgentPrivacyNotices = Record<string, AgentPrivacyNotice>;

const PRIVACY_NOTICE_MAX_LOCALES = 10;
const MAX_TEXT_LENGTH = 200;
/**
 * Below the operator MCP's 500-character read cap, so `agent_configuration` never shows Ray a cut
 * link that a whole-block `branding` proposal would then save.
 */
const MAX_URL_LENGTH = 500;
const VERSION_HASH_LENGTH = 16;
/** A language tag (35) and the hash, with room to spare; the bound a reported version is held to. */
export const PRIVACY_NOTICE_VERSION_MAX_LENGTH = 64;

const localeKeySchema = z.string().refine(isLocaleTag, { message: "Must be a language tag such as en or it-IT" });

/**
 * What a write accepts. `version` may ride along, as `agent_configuration` and the agent read show
 * it, and is ignored: the domain recomputes it. Semantic checks (one line, a web link) are the
 * domain's, so the dashboard, the PUT route and Ray see one set of messages.
 */
export const agentPrivacyNoticesInputSchema = z.record(
  localeKeySchema,
  z.object({
    text: z.string().max(MAX_TEXT_LENGTH),
    url: z.string().max(MAX_URL_LENGTH),
    version: z.string().max(PRIVACY_NOTICE_VERSION_MAX_LENGTH).optional(),
  }),
).refine((record) => Object.keys(record).length <= PRIVACY_NOTICE_MAX_LOCALES, {
  message: `At most ${PRIVACY_NOTICE_MAX_LOCALES} languages`,
}).describe(
  "The operator's privacy notice per language tag: one line (text) and their policy link (url), shown word for word before a "
  + "visitor's first message. Replaced whole: leaving a language out removes its notice.",
);

/** The notices as the agent serves them. */
export const agentPrivacyNoticesSchema = z.record(
  localeKeySchema,
  z.object({ text: z.string(), url: z.string(), version: z.string() }),
);

const fieldOf = (locale: string, field: "text" | "url") => `branding.privacyNotice.${locale}.${field}`;

const privacyNoticeVersion = (locale: string, notice: Pick<AgentPrivacyNotice, "text" | "url">): string => {
  const digest = createHash("sha256").update(JSON.stringify([locale, notice.text, notice.url])).digest("hex");
  return `${locale}:${digest.slice(0, VERSION_HASH_LENGTH)}`;
};

const normalizeText = (locale: string, value: unknown): string => {
  if (typeof value !== "string") throw badRequest(`${fieldOf(locale, "text")} must be a string`);
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) throw badRequest(`${fieldOf(locale, "text")} is required`);
  if (line.length > MAX_TEXT_LENGTH) {
    throw badRequest(`${fieldOf(locale, "text")} must not exceed ${MAX_TEXT_LENGTH} characters`);
  }
  return line;
};

const normalizeUrl = (locale: string, value: unknown): string => {
  if (typeof value !== "string") throw badRequest(`${fieldOf(locale, "url")} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw badRequest(`${fieldOf(locale, "url")} is required`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest(`${fieldOf(locale, "url")} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest(`${fieldOf(locale, "url")} must use http or https`);
  }
  const url = parsed.toString();
  if (url.length > MAX_URL_LENGTH) {
    throw badRequest(`${fieldOf(locale, "url")} must not exceed ${MAX_URL_LENGTH} characters`);
  }
  return url;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizePrivacyNotices = (value: unknown): AgentPrivacyNotices => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw badRequest("branding.privacyNotice must be an object keyed by language tag");
  const entries = Object.entries(value);
  if (entries.length > PRIVACY_NOTICE_MAX_LOCALES) {
    throw badRequest(`branding.privacyNotice must not hold more than ${PRIVACY_NOTICE_MAX_LOCALES} languages`);
  }
  const seen = new Set<string>();
  const notices: AgentPrivacyNotices = {};
  for (const [rawLocale, entry] of entries) {
    const locale = rawLocale.trim();
    if (!isLocaleTag(locale)) throw badRequest(`branding.privacyNotice key ${JSON.stringify(rawLocale.slice(0, 40))} must be a language tag`);
    if (seen.has(locale.toLowerCase())) throw badRequest(`branding.privacyNotice must name ${locale} once`);
    seen.add(locale.toLowerCase());
    if (!isRecord(entry)) throw badRequest(`branding.privacyNotice.${locale} must be an object`);
    const text = normalizeText(locale, entry.text);
    const url = normalizeUrl(locale, entry.url);
    notices[locale] = { text, url, version: privacyNoticeVersion(locale, { text, url }) };
  }
  return notices;
};

const languageOf = (tag: string): string => tag.split("-")[0]?.toLowerCase() ?? "";

/** The exact tag, else the bare language, else any tag of the same language. Tag structure only. */
const matchLocale = (tags: readonly string[], wanted: string): string | null => {
  const exact = wanted.toLowerCase();
  const language = languageOf(wanted);
  return tags.find((tag) => tag.toLowerCase() === exact)
    ?? tags.find((tag) => tag.toLowerCase() === language)
    ?? tags.find((tag) => languageOf(tag) === language)
    ?? null;
};

/**
 * The notice a conversation is shown: in the first preferred language the agent wrote one for,
 * else English, else the first language in tag order. A visitor is better informed in another
 * language than not at all. Null when the agent wrote none.
 */
export const choosePrivacyNotice = (
  notices: AgentPrivacyNotices,
  preferred: readonly (string | null | undefined)[],
): (AgentPrivacyNotice & { locale: string }) | null => {
  const tags = Object.keys(notices).sort();
  if (tags.length === 0) return null;
  const wanted = [...preferred.filter((tag): tag is string => Boolean(tag?.trim())), "en"];
  const locale = wanted.map((tag) => matchLocale(tags, tag.trim())).find((tag) => tag !== null) ?? tags[0];
  const notice = notices[locale];
  return { locale, ...notice };
};

/** Whether a version a client reports is one the agent's notices carry now. */
export const isPrivacyNoticeVersionOf = (notices: AgentPrivacyNotices, version: string): boolean =>
  Object.values(notices).some((notice) => notice.version === version);
