import { describe, expect, it } from "vitest";

import {
  capabilityNames,
  StrictCapabilityPolicy,
} from "../../src/shared/domain/capabilityPolicy.js";
import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { createAuditService } from "../support/fakes.js";

const createRepository = () => {
  let deleted = false;

  return {
    get deleted() {
      return deleted;
    },
    async findByIdAndWorkspaceId() {
      return {
        id: "doc-1",
        workspaceId: "workspace-1",
        title: "Inline",
        sourceContent: "Inline body",
        markdownContent: "Inline body",
        metadata: {},
        sourceKind: "inline_text" as const,
        sourceFilename: null,
        sourceMimeType: "text/plain",
        sourceStorageBucket: null,
        sourceStorageObject: null,
        sourceStorageGeneration: null,
        sourceSizeBytes: null,
        status: "ready" as const,
        revision: 1,
        failureReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async deleteByIdAndWorkspaceId() {
      deleted = true;
      return true;
    },
  };
};

const storage = {
  async upload() {
    throw new Error("unused");
  },
  async read() {
    throw new Error("unused");
  },
  async delete() {
    throw new Error("unused");
  },
};

describe("document capability policy", () => {
  it("denies document deletion before mutation when policy blocks the capability", async () => {
    const repository = createRepository();
    const service = new DocumentDeletionService(
      repository,
      storage,
      createAuditService(),
      new StrictCapabilityPolicy({
        deniedCapabilities: [capabilityNames.documents.delete],
      }),
    );

    await expect(service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    })).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });

    expect(repository.deleted).toBe(false);
  });

  it("allows document deletion by default", async () => {
    const repository = createRepository();
    const service = new DocumentDeletionService(
      repository,
      storage,
      createAuditService(),
    );

    await service.delete({
      workspaceId: "workspace-1",
      documentId: "doc-1",
    });

    expect(repository.deleted).toBe(true);
  });
});
