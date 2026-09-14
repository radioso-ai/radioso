import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import {
  createAppStorageComposition,
  createAppStorageDiagnostics,
  type AppStorageComposition,
} from "../../../src/app/composition/appStorage.js";
import type { AuditOutboxPort } from "../../../src/modules/audit/composition.js";
import type { AppLogger } from "../../../src/shared/observability/logger.js";
import type { DB } from "../../../src/shared/infra/kysely/types.js";

const buildAuditOutbox = (): AuditOutboxPort => ({
  enqueue: vi.fn(async () => []),
});

const buildLogger = (): AppLogger & { error: ReturnType<typeof vi.fn> } =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as AppLogger & {
    error: ReturnType<typeof vi.fn>;
  };

describe("app storage composition", () => {
  it("assembles the repository, service, disposition, rebuilder, and sweeper", () => {
    const composition: AppStorageComposition = createAppStorageComposition({
      // Composition wires implementations; nothing here reaches the connection.
      kysely: {} as Kysely<DB>,
      auditOutbox: buildAuditOutbox(),
      logger: buildLogger(),
    });

    expect(typeof composition.service.put).toBe("function");
    expect(typeof composition.compatibilityFacts.storedSchemaVersions).toBe("function");
    expect(typeof composition.disposition.cancelRetention).toBe("function");
    expect(typeof composition.disposition.export).toBe("function");
    expect(typeof composition.sweeper.runExpirySweep).toBe("function");
    expect(typeof composition.sweeper.runRetentionSweep).toBe("function");
    expect(typeof composition.sweeper.runIndexRebuildSweep).toBe("function");
    expect(typeof composition.indexRebuilder.rebuildIndex).toBe("function");
    expect(typeof composition.repository.findRecord).toBe("function");
  });

  it("adapts the platform logger's `error` method to the diagnostics port every service requires", () => {
    const logger = buildLogger();
    const diagnostics = createAppStorageDiagnostics(logger);

    diagnostics.failure(
      {
        operation: "put",
        classification: "internal",
        exceptionClass: "Error",
        sqlState: null,
        constraint: null,
        stack: null,
      },
      "put converted an exception to internal",
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "put", classification: "internal" }),
      "put converted an exception to internal",
    );
  });
});
