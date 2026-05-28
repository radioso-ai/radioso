const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_LABEL_FORMATTERS = [
  new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }),
  new Intl.DateTimeFormat("it", { month: "long", year: "numeric", timeZone: "UTC" }),
];

export const renderSearchText = (input: {
  title: string;
  subjectLabel?: string | null;
  sectionPath?: string | null;
  attributeText?: string | null;
  content: string;
}): string => {
  const parts = [
    input.title ? `Title: ${normalizeWhitespace(input.title)}` : "",
    input.subjectLabel ? `Subject: ${normalizeWhitespace(input.subjectLabel)}` : "",
    input.sectionPath ? `Section: ${normalizeWhitespace(input.sectionPath)}` : "",
    input.attributeText ? `Attributes: ${normalizeWhitespace(input.attributeText)}` : "",
    normalizeWhitespace(input.content),
  ].filter((part) => part.length > 0);

  return parts.join("\n\n");
};

export const renderMetadataSearchText = (metadata: Record<string, unknown>): string => {
  const dateFrom = normalizeIsoDay(metadata.dateFrom);
  const dateTo = normalizeIsoDay(metadata.dateTo);
  const url = pickMetadataUrl(metadata);
  const monthKeys = collectMonthKeys(dateFrom, dateTo);
  const monthLabels = monthKeys.flatMap((monthKey) => renderMonthLabels(monthKey));

  const parts = [
    dateFrom ? `Date from: ${dateFrom}` : "",
    dateTo ? `Date to: ${dateTo}` : "",
    ...monthKeys.map((monthKey) => `Month key: ${monthKey}`),
    ...monthLabels.map((label) => `Month label: ${label}`),
    url ? `URL: ${url}` : "",
  ].filter((part) => part.length > 0);

  return parts.join(" | ");
};

const pickMetadataUrl = (metadata: Record<string, unknown>): string => {
  const sourceUrl = typeof metadata.sourceUrl === "string" ? normalizeWhitespace(metadata.sourceUrl) : "";
  if (sourceUrl) {
    return sourceUrl;
  }
  return typeof metadata.url === "string" ? normalizeWhitespace(metadata.url) : "";
};

const normalizeIsoDay = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return ISO_DAY_PATTERN.test(normalized) ? normalized : null;
};

const collectMonthKeys = (dateFrom: string | null, dateTo: string | null): string[] => {
  const start = dateFrom ?? dateTo;
  const end = dateTo ?? dateFrom;
  if (!start || !end) {
    return [];
  }

  const startParts = parseIsoDay(start);
  const endParts = parseIsoDay(end);
  if (!startParts || !endParts) {
    return [];
  }

  const keys: string[] = [];
  let year = startParts.year;
  let month = startParts.month;
  while (year < endParts.year || (year === endParts.year && month <= endParts.month)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return keys;
};

const parseIsoDay = (value: string): { year: number; month: number } | null => {
  if (!ISO_DAY_PATTERN.test(value)) {
    return null;
  }

  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month };
};

const renderMonthLabels = (monthKey: string): string[] => {
  const [yearText, monthText] = monthKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return [];
  }

  const date = new Date(Date.UTC(year, month - 1, 1));
  return [...new Set(MONTH_LABEL_FORMATTERS.map((formatter) => normalizeWhitespace(formatter.format(date))))];
};
