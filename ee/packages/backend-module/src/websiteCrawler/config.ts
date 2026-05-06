import { WebsiteCrawlerUnavailableError } from "./errors.js";

export type WebsiteCrawlerConfig = {
  // defaultLimit is used when callers omit limit. maxLimit caps caller input,
  // the provider request, and local page publication for each crawl.
  defaultLimit: number;
  maxLimit: number;
};

export type WebsiteCrawlerEnv = Partial<Record<
  "EE_WEBSITE_CRAWLER_DEFAULT_LIMIT" | "EE_WEBSITE_CRAWLER_MAX_LIMIT",
  string | undefined
>>;

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_LIMIT = 100;

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
  const maxLimit = readInteger(env.EE_WEBSITE_CRAWLER_MAX_LIMIT, DEFAULT_MAX_LIMIT, "EE_WEBSITE_CRAWLER_MAX_LIMIT");
  const defaultLimit = Math.min(
    readInteger(env.EE_WEBSITE_CRAWLER_DEFAULT_LIMIT, DEFAULT_LIMIT, "EE_WEBSITE_CRAWLER_DEFAULT_LIMIT"),
    maxLimit,
  );
  return {
    defaultLimit,
    maxLimit,
  };
};
