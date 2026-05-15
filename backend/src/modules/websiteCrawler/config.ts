import { WebsiteCrawlerUnavailableError } from "./errors.js";

export type WebsiteCrawlerConfig = {
  // defaultLimit is used when callers omit limit. maxLimit caps caller input,
  // the provider request, and local page publication for each crawl.
  defaultLimit: number;
  maxLimit: number;
  userAgent: string;
};

export type WebsiteCrawlerEnv = Partial<Record<
  "WEBSITE_CRAWLER_DEFAULT_LIMIT" | "WEBSITE_CRAWLER_MAX_LIMIT" | "WEBSITE_CRAWLER_USER_AGENT",
  string | undefined
>>;

const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_LIMIT = 1000;
export const DEFAULT_WEBSITE_CRAWLER_USER_AGENT = "RadiosoCrawler/1.0";

const readInteger = (
  value: string | undefined,
  fallback: number,
  envName: string,
): number => {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new WebsiteCrawlerUnavailableError(`${envName} must be a positive integer`, {
      invalidEnv: envName,
    });
  }
  return parsed;
};

export const resolveWebsiteCrawlerConfig = (
  env: WebsiteCrawlerEnv = process.env,
): WebsiteCrawlerConfig => {
  const maxLimit = readInteger(env.WEBSITE_CRAWLER_MAX_LIMIT, DEFAULT_MAX_LIMIT, "WEBSITE_CRAWLER_MAX_LIMIT");
  const defaultLimit = Math.min(
    readInteger(env.WEBSITE_CRAWLER_DEFAULT_LIMIT, DEFAULT_LIMIT, "WEBSITE_CRAWLER_DEFAULT_LIMIT"),
    maxLimit,
  );
  const userAgent = env.WEBSITE_CRAWLER_USER_AGENT?.trim() || DEFAULT_WEBSITE_CRAWLER_USER_AGENT;
  return {
    defaultLimit,
    maxLimit,
    userAgent,
  };
};
