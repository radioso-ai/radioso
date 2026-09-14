import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { createAppStorageComposition, type AppStorageComposition } from "../../../src/app/composition/appStorage.js";
import type { AuditOutboxPort } from "../../../src/modules/audit/composition.js";
import type { DB } from "../../../src/shared/infra/kysely/types.js";

const buildAuditOutbox = (): AuditOutboxPort => ({
  enqueue: vi.fn(async () => []),
});

describe("app storage composition", () => {
  it("assembles the repository, service, disposition, rebuilder, and sweeper", () => {
    const composition: AppStorageComposition = createAppStorageComposition({
      // Composition wires implementations; nothing here reaches the connection.
      kysely: {} as Kysely<DB>,
      auditOutbox: buildAuditOutbox(),
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
});
