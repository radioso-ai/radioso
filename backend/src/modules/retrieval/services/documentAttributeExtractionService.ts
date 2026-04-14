import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import type { RawStructuredAttributes, StructuredAttributes } from "../domain/structuredAttributes.js";
import { emptyStructuredAttributes } from "../domain/structuredAttributes.js";
import { normalizeDateConstraint, normalizeStructuredAttributes } from "./attributeNormalizer.js";

const DOCUMENT_ATTRIBUTE_EXTRACTION_SYSTEM_PROMPT = `Extract structured retrieval attributes from a document chunk.
Return strict JSON only.

Rules:
- Use only facts explicitly supported by the provided title and content.
- Do not infer from external knowledge.
- Prefer no attribute over a guessed attribute.
- Ignore metadata fields supplied outside the content; metadata is handled separately.
- Dates must use ISO format YYYY-MM-DD when explicitly known.
- Locations should use the explicit place text from the content.
- Money should include amountText and currencyText when explicitly stated.

Return this shape exactly:
{"datePoints":[{"value":"YYYY-MM-DD","sourceText":"string"}],"dateRanges":[{"start":"YYYY-MM-DD","end":"YYYY-MM-DD","sourceText":"string"}],"moneyValues":[{"amountText":"string","currencyText":"EUR","sourceText":"string"}],"locations":[{"value":"string","sourceText":"string"}]}
`;

export interface DocumentAttributeExtractionGateway {
  extract(input: {
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<RawStructuredAttributes>;
}

export class ModelDocumentAttributeExtractionGateway implements DocumentAttributeExtractionGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async extract(input: {
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<RawStructuredAttributes> {
    const raw = await this.client.complete({
      systemPrompt: DOCUMENT_ATTRIBUTE_EXTRACTION_SYSTEM_PROMPT,
      prompt: `Title:\n${input.title}\n\nContent:\n${input.content}`,
      temperature: 0,
      maxOutputTokens: 500,
    });

    return parseRawStructuredAttributes(raw);
  }
}

export interface DocumentAttributeExtractionService {
  extract(input: {
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  }): Promise<StructuredAttributes>;
}

export class MetadataBackedDocumentAttributeExtractionService implements DocumentAttributeExtractionService {
  async extract(input: { title: string; content: string; metadata: Record<string, unknown> }): Promise<StructuredAttributes> {
    const metadataAttributes = emptyStructuredAttributes();
    const dateFrom = normalizeDateConstraint(readString(input.metadata.dateFrom));
    const dateTo = normalizeDateConstraint(readString(input.metadata.dateTo));

    if (dateFrom && dateTo && dateFrom <= dateTo) {
      metadataAttributes.dateRanges.push({
        start: dateFrom,
        end: dateTo,
        confidence: 1,
        sourceText: "metadata.dateFrom/dateTo",
      });
    } else if (dateFrom) {
      metadataAttributes.datePoints.push({
        value: dateFrom,
        granularity: "day",
        confidence: 1,
        sourceText: "metadata.dateFrom",
      });
    } else if (dateTo) {
      metadataAttributes.datePoints.push({
        value: dateTo,
        granularity: "day",
        confidence: 1,
        sourceText: "metadata.dateTo",
      });
    }

    return metadataAttributes;
  }
}

export class SemanticDocumentAttributeExtractionService implements DocumentAttributeExtractionService {
  constructor(private readonly gateway?: DocumentAttributeExtractionGateway) {}

  async extract(input: { title: string; content: string; metadata: Record<string, unknown> }): Promise<StructuredAttributes> {
    if (!this.gateway) {
      return emptyStructuredAttributes();
    }

    try {
      const raw = await this.gateway.extract(input);
      return normalizeStructuredAttributes(raw);
    } catch {
      return emptyStructuredAttributes();
    }
  }
}

export class CompositeDocumentAttributeExtractionService implements DocumentAttributeExtractionService {
  constructor(
    private readonly metadataExtractor: DocumentAttributeExtractionService = new MetadataBackedDocumentAttributeExtractionService(),
    private readonly semanticExtractor: DocumentAttributeExtractionService = new SemanticDocumentAttributeExtractionService(),
  ) {}

  async extract(input: { title: string; content: string; metadata: Record<string, unknown> }): Promise<StructuredAttributes> {
    const [metadataAttributes, semanticAttributes] = await Promise.all([
      this.metadataExtractor.extract(input),
      this.semanticExtractor.extract(input),
    ]);
    return mergeAttributes(metadataAttributes, semanticAttributes);
  }
}

const readString = (value: unknown): string => (typeof value === "string" ? value : "");

const mergeAttributes = (primary: StructuredAttributes, secondary: StructuredAttributes): StructuredAttributes => ({
  datePoints: dedupeByKey([...primary.datePoints, ...secondary.datePoints], (item) => item.value),
  dateRanges: dedupeByKey([...primary.dateRanges, ...secondary.dateRanges], (item) => `${item.start}:${item.end}`),
  moneyValues: dedupeByKey(
    [...primary.moneyValues, ...secondary.moneyValues],
    (item) => `${item.amount}:${item.currencyCode ?? ""}`,
  ),
  locations: dedupeByKey([...primary.locations, ...secondary.locations], (item) => item.matchKey),
});

const dedupeByKey = <T>(values: T[], getKey: (value: T) => string): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = getKey(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
};

const parseRawStructuredAttributes = (raw: string): RawStructuredAttributes => {
  const normalized = raw.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  return sanitizeRawStructuredAttributes(JSON.parse(normalized));
};

const sanitizeRawStructuredAttributes = (value: unknown): RawStructuredAttributes => {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    datePoints: sanitizeDatePoints(record.datePoints),
    dateRanges: sanitizeDateRanges(record.dateRanges),
    moneyValues: sanitizeMoneyValues(record.moneyValues),
    locations: sanitizeLocations(record.locations),
  };
};

const sanitizeDatePoints = (value: unknown): RawStructuredAttributes["datePoints"] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        const date = readString(record.value);
        const sourceText = readString(record.sourceText);
        return date && sourceText ? [{ value: date, sourceText }] : [];
      })
    : [];

const sanitizeDateRanges = (value: unknown): RawStructuredAttributes["dateRanges"] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        const start = readString(record.start);
        const end = readString(record.end);
        const sourceText = readString(record.sourceText);
        return start && end && sourceText ? [{ start, end, sourceText }] : [];
      })
    : [];

const sanitizeMoneyValues = (value: unknown): RawStructuredAttributes["moneyValues"] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        const amountText = readString(record.amountText);
        const sourceText = readString(record.sourceText);
        const currencyText =
          typeof record.currencyText === "string" || record.currencyText === null ? record.currencyText : undefined;
        return amountText && sourceText ? [{ amountText, currencyText, sourceText }] : [];
      })
    : [];

const sanitizeLocations = (value: unknown): RawStructuredAttributes["locations"] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        const location = readString(record.value);
        const sourceText = readString(record.sourceText);
        return location && sourceText ? [{ value: location, sourceText }] : [];
      })
    : [];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
