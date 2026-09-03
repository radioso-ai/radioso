// Cloud Logging classifies a structured log line by its `severity` field. Pino writes a
// numeric `level` instead, so without this mapping every backend line — including stack
// traces — is ingested at the default severity and an operator filtering for errors sees
// an empty result set. Emitting both keeps the numeric level for existing log queries.
export type CloudLoggingSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

const severityByAscendingLevel: ReadonlyArray<readonly [number, CloudLoggingSeverity]> = [
  [20, "DEBUG"],
  [30, "INFO"],
  [40, "WARNING"],
  [50, "ERROR"],
  [60, "CRITICAL"],
];

export const toCloudLoggingSeverity = (level: number): CloudLoggingSeverity => {
  let severity: CloudLoggingSeverity = severityByAscendingLevel[0][1];

  // Custom levels land between the standard ones; round down so an unrecognized level is
  // reported at the severity of the nearest standard level it exceeds, never above it.
  for (const [threshold, candidate] of severityByAscendingLevel) {
    if (level >= threshold) {
      severity = candidate;
    }
  }

  return severity;
};
