const units = [
  { suffix: "TB", bytes: 1024 ** 4 },
  { suffix: "GB", bytes: 1024 ** 3 },
  { suffix: "MB", bytes: 1024 ** 2 },
  { suffix: "KB", bytes: 1024 },
  { suffix: "B", bytes: 1 },
] as const;

export type ByteUnit = (typeof units)[number]["suffix"];

export interface ParsedByteLimit {
  bytes: number;
  unit: ByteUnit;
}

export const parseHumanBytes = (value: string): number => {
  const trimmed = value.trim();
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Enter a byte limit with a unit, such as 512 MB or 2 GB.");
  }

  const amount = Number(match[1]);
  const unit = units.find((candidate) => candidate.suffix === match[2].toUpperCase());
  if (!Number.isFinite(amount) || amount < 0 || !unit) {
    throw new Error("Byte limit must be a non-negative number.");
  }

  const bytes = amount * unit.bytes;
  if (!Number.isInteger(bytes) || !Number.isSafeInteger(bytes)) {
    throw new Error("Byte limit must resolve to a whole safe byte count.");
  }
  return bytes;
};

export const formatHumanBytes = (bytes: number | null): string => {
  if (bytes === null) {
    return "unlimited";
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Byte count must be a non-negative safe integer.");
  }
  if (bytes === 0) {
    return "0 B";
  }

  const displayUnit = units.find((unit) => bytes >= unit.bytes) ?? units[units.length - 1];
  const value = bytes / displayUnit.bytes;
  const normalized = Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/\.?0+$/, "");
  return `${normalized} ${displayUnit.suffix}`;
};

export const parseNullableHumanBytes = (value: string): number | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.toLowerCase() === "unlimited"
    ? null
    : parseHumanBytes(trimmed);
};

export const formatNullableByteInput = (bytes: number | null): string =>
  bytes === null ? "" : formatHumanBytes(bytes);
