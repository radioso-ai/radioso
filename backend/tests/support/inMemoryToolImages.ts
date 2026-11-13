import type {
  ClaimedToolImage,
  ToolImageCaptureOutcome,
  ToolImageClaim,
  ToolImageObject,
  ToolImageRendition,
  ToolImageStore,
} from "../../src/modules/toolImages/domain.js";

interface MemoryToolImageRow {
  workspaceId: string;
  url: string | null;
  status: "pending" | "capturing" | "stored" | "failed";
  claimedAt: Date | null;
  reason: string | null;
  renditions: ToolImageRendition[];
  stored: { width: number; height: number; sha256: string } | null;
}

/**
 * `conversation_tool_images` in memory, claimed and settled the way the Postgres store does: a
 * claim older than 30 seconds may be taken over, and every finishing write matches the claim's
 * generation. Objects handed to the deletion job are kept in `handedOff`.
 */
export class InMemoryToolImageStore implements ToolImageStore {
  readonly rows = new Map<string, MemoryToolImageRow>();
  readonly handedOff: ToolImageObject[] = [];

  add(imageId: string, workspaceId: string, url: string): void {
    this.rows.set(imageId, { workspaceId, url, status: "pending", claimedAt: null, reason: null, renditions: [], stored: null });
  }

  async claim(imageId: string, now: Date): Promise<ToolImageClaim> {
    const row = this.rows.get(imageId);
    if (!row) return { kind: "missing" };
    if (row.status === "stored") return { kind: "stored" };
    if (row.status === "failed") return { kind: "failed" };
    const stale = row.status === "capturing" && row.claimedAt !== null && row.claimedAt.getTime() < now.getTime() - 30_000;
    if (row.status === "capturing" && !stale) return { kind: "held" };
    row.status = "capturing";
    row.claimedAt = now;
    return { kind: "claimed", image: { id: imageId, workspaceId: row.workspaceId, url: row.url ?? "", claimedAt: now } };
  }

  private holds(image: ClaimedToolImage): MemoryToolImageRow | null {
    const row = this.rows.get(image.id);
    return row && row.status === "capturing" && row.claimedAt?.getTime() === image.claimedAt.getTime() ? row : null;
  }

  async markStored(input: { image: ClaimedToolImage; width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }): Promise<boolean> {
    const row = this.holds(input.image);
    if (!row) {
      this.handedOff.push(...input.renditions);
      return false;
    }
    row.status = "stored";
    row.claimedAt = null;
    row.url = null;
    row.stored = { width: input.width, height: input.height, sha256: input.sha256 };
    row.renditions = [...input.renditions];
    return true;
  }

  async markFailed(input: { image: ClaimedToolImage; reason: ToolImageCaptureOutcome }): Promise<void> {
    const row = this.holds(input.image);
    if (!row) return;
    row.status = "failed";
    row.claimedAt = null;
    row.url = null;
    row.reason = input.reason;
  }

  async release(input: { image: ClaimedToolImage; reason: ToolImageCaptureOutcome; leftovers: readonly ToolImageObject[] }): Promise<void> {
    this.handedOff.push(...input.leftovers);
    const row = this.holds(input.image);
    if (!row) return;
    row.status = "pending";
    row.claimedAt = null;
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
        row.claimedAt = null;
        row.url = null;
        row.reason = input.reason;
      }
    }
  }
}
