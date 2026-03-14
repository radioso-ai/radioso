import {
  emptyStructuredAttributes,
  type NormalizedDatePoint,
  type NormalizedDateRange,
  type NormalizedLocationValue,
  type NormalizedMoneyValue,
  type RawStructuredAttributes,
  type StructuredAttributes,
} from "../domain/structuredAttributes.js";

const normalizeDate = (value: string): string | null => {
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
};

const normalizeMoney = (amountText: string, currencyText?: string | null): NormalizedMoneyValue | null => {
  const amount = Number(amountText);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return {
    amount,
    currencyCode: currencyText?.trim().toUpperCase() ?? null,
    confidence: 0.95,
    sourceText: currencyText ? `${amountText} ${currencyText}` : amountText,
  };
};

const normalizeLocation = (value: string): NormalizedLocationValue | null => {
  const displayName = value.trim().replace(/\s+/g, " ");
  if (!displayName) {
    return null;
  }

  return {
    matchKey: displayName.toLowerCase(),
    displayName,
    confidence: 0.95,
    sourceText: value,
  };
};

export const normalizeStructuredAttributes = (raw: RawStructuredAttributes): StructuredAttributes => {
  const normalized = emptyStructuredAttributes();

  for (const datePoint of raw.datePoints) {
    const value = normalizeDate(datePoint.value);
    if (!value) {
      continue;
    }
    const normalizedDatePoint: NormalizedDatePoint = {
      value,
      granularity: "day",
      confidence: 0.95,
      sourceText: datePoint.sourceText,
    };
    normalized.datePoints.push(normalizedDatePoint);
  }

  for (const dateRange of raw.dateRanges) {
    const start = normalizeDate(dateRange.start);
    const end = normalizeDate(dateRange.end);
    if (!start || !end || start > end) {
      continue;
    }
    const normalizedDateRange: NormalizedDateRange = {
      start,
      end,
      confidence: 0.95,
      sourceText: dateRange.sourceText,
    };
    normalized.dateRanges.push(normalizedDateRange);
  }

  for (const moneyValue of raw.moneyValues) {
    const normalizedMoney = normalizeMoney(moneyValue.amountText, moneyValue.currencyText);
    if (normalizedMoney) {
      normalized.moneyValues.push({
        ...normalizedMoney,
        sourceText: moneyValue.sourceText,
      });
    }
  }

  for (const location of raw.locations) {
    const normalizedLocation = normalizeLocation(location.value);
    if (normalizedLocation) {
      normalized.locations.push({
        ...normalizedLocation,
        sourceText: location.sourceText,
      });
    }
  }

  return normalized;
};

export const normalizeDateConstraint = (value: string): string | null => normalizeDate(value);

export const normalizeMoneyConstraint = (amountText: string, currencyText?: string | null): {
  amount: number;
  currencyCode: string | null;
} | null => {
  const normalized = normalizeMoney(amountText, currencyText);
  if (!normalized) {
    return null;
  }

  return {
    amount: normalized.amount,
    currencyCode: normalized.currencyCode,
  };
};

export const normalizeLocationConstraint = (value: string): {
  matchKey: string;
  displayName: string;
} | null => {
  const normalized = normalizeLocation(value);
  if (!normalized) {
    return null;
  }

  return {
    matchKey: normalized.matchKey,
    displayName: normalized.displayName,
  };
};
