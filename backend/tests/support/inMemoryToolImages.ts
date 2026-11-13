import type {
  ClaimedToolImage,
  ToolImageCaptureOutcome,
  ToolImageClaim,
  ToolImageRendition,
  ToolImageStore,
} from "../../src/modules/toolImages/domain.js";

interface MemoryToolImageRow {
  workspaceId: string;
  source: ClaimedToolImage["source"];
  status: "pending" | "capturing" | "stored" | "failed";
  reason: string | null;
  renditions: ToolImageRendition[];
  stored: { width: number; height: number; sha256: string } | null;
}

/** `conversation_tool_images` in memory, claimed and settled the way the Postgres store does. */
export class InMemoryToolImageStore implements ToolImageStore {
  readonly rows = new Map<string, MemoryToolImageRow>();

  add(imageId: string, workspaceId: string, source: ClaimedToolImage["source"]): void {
    this.rows.set(imageId, { workspaceId, source, status: "pending", reason: null, renditions: [], stored: null });
  }

  async claim(imageId: string): Promise<ToolImageClaim> {
    const row = this.rows.get(imageId);
    if (!row) return { kind: "missing" };
    if (row.status === "stored") return { kind: "stored" };
    if (row.status === "failed") return { kind: "failed" };
    if (row.status === "capturing") return { kind: "held" };
    row.status = "capturing";
    return { kind: "claimed", image: { id: imageId, workspaceId: row.workspaceId, source: row.source } };
  }

  async markStored(input: { imageId: string; width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }): Promise<void> {
    const row = this.rows.get(input.imageId);
    if (!row) return;
    row.status = "stored";
    row.stored = { width: input.width, height: input.height, sha256: input.sha256 };
    row.renditions = [...input.renditions];
  }

  async markFailed(input: { imageId: string; reason: ToolImageCaptureOutcome }): Promise<void> {
    const row = this.rows.get(input.imageId);
    if (!row) return;
    row.status = "failed";
    row.reason = input.reason;
  }

  async release(input: { imageId: string; reason: ToolImageCaptureOutcome }): Promise<void> {
    const row = this.rows.get(input.imageId);
    if (!row) return;
    row.status = "pending";
    row.reason = input.reason;
  }

  async findRendition(input: { imageId: string; width: number }): Promise<ToolImageRendition | null> {
    const row = this.rows.get(input.imageId);
    return row?.status === "stored" ? row.renditions.find((rendition) => rendition.width === input.width) ?? null : null;
  }

  async failPending(input: { imageIds: readonly string[]; reason: "retries_exhausted" }): Promise<void> {
    for (const imageId of input.imageIds) {
      const row = this.rows.get(imageId);
      if (row && (row.status === "pending" || row.status === "capturing")) {
        row.status = "failed";
        row.reason = input.reason;
      }
    }
  }
}
