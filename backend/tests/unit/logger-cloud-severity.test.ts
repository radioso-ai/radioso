import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { toCloudLoggingSeverity } from "../../src/shared/observability/logging/cloudSeverity.js";
import { createLogger } from "../../src/shared/observability/logger.js";

const captureLines = (): { stream: Writable; lines: string[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  return { stream, lines };
};

describe("toCloudLoggingSeverity", () => {
  it.each([
    [10, "DEBUG"],
    [20, "DEBUG"],
    [30, "INFO"],
    [40, "WARNING"],
    [50, "ERROR"],
    [60, "CRITICAL"],
  ])("maps pino level %i to %s", (level, expected) => {
    expect(toCloudLoggingSeverity(level)).toBe(expected);
  });

  it("clamps levels below and above the known range", () => {
    expect(toCloudLoggingSeverity(0)).toBe("DEBUG");
    expect(toCloudLoggingSeverity(70)).toBe("CRITICAL");
  });

  it("maps custom levels to the next lower configured severity", () => {
    expect(toCloudLoggingSeverity(35)).toBe("INFO");
    expect(toCloudLoggingSeverity(55)).toBe("ERROR");
  });
});

describe("createLogger severity output", () => {
  it("emits a Cloud Logging severity alongside the numeric pino level", () => {
    const { stream, lines } = captureLines();
    const logger = createLogger("debug", stream);

    logger.error({ event: "boom" }, "failed");
    logger.info({ event: "fine" }, "ok");

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records[0]).toMatchObject({ level: 50, severity: "ERROR" });
    expect(records[1]).toMatchObject({ level: 30, severity: "INFO" });
  });
});
