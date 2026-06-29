import { describe, expect, it } from "vitest";

import { formatHumanBytes, parseHumanBytes, parseNullableHumanBytes } from "../lib/byte-units";

describe("byte units", () => {
  it("round-trips human MB and GB values to bytes", () => {
    expect(parseHumanBytes("512 MB")).toBe(512 * 1024 * 1024);
    expect(parseHumanBytes("2 GB")).toBe(2 * 1024 * 1024 * 1024);
    expect(formatHumanBytes(parseHumanBytes("512 MB"))).toBe("512 MB");
    expect(formatHumanBytes(parseHumanBytes("2 GB"))).toBe("2 GB");
  });

  it("normalizes to the largest exact unit", () => {
    expect(formatHumanBytes(parseHumanBytes("1024 MB"))).toBe("1 GB");
    expect(formatHumanBytes(parseHumanBytes("1048576 KB"))).toBe("1 GB");
    expect(formatHumanBytes(0)).toBe("0 B");
  });

  it("uses fixed precision when no larger exact unit exists", () => {
    expect(formatHumanBytes(1536)).toBe("1.5 KB");
    expect(formatHumanBytes(5 * 1024 * 1024 + 512 * 1024)).toBe("5.5 MB");
  });

  it("parses nullable form inputs", () => {
    expect(parseNullableHumanBytes("")).toBeNull();
    expect(parseNullableHumanBytes("unlimited")).toBeNull();
    expect(parseNullableHumanBytes("1.5 GB")).toBe(1.5 * 1024 * 1024 * 1024);
  });

  it("rejects invalid or non-integral byte values", () => {
    expect(() => parseHumanBytes("10 apples")).toThrow(/unit/);
    expect(() => parseHumanBytes("-1 MB")).toThrow(/unit/);
    expect(() => parseHumanBytes("0.1 B")).toThrow(/whole safe byte/);
  });
});
