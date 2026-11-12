import { randomUUID } from "node:crypto";

import { sniffImageType } from "../../../shared/infra/images/imageSniff.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { ToolImageIntake, ToolImageIntakeDropReason } from "../contracts/index.js";
import { TOOL_IMAGE_LIMITS, TOOL_IMAGE_TYPES, type ToolImageObject, type ToolImageObjectStore } from "../domain.js";

/**
 * Keeps a picture an MCP tool returned as bytes, while the call runs: its type is read from its
 * magic bytes, it is uploaded untouched as the picture's source, and an unbound row records it for
 * the reply that shows it to bind. The capture job re-encodes it later; a picture no reply binds
 * is swept after a day.
 */
export class StoredToolImageIntake implements ToolImageIntake {
  constructor(
    private readonly deps: {
      objects: Pick<ToolImageObjectStore, "put" | "locate">;
      rows: { insertInline(input: { id: string; workspaceId: string; conversationId: string; object: ToolImageObject }): Promise<void> };
      logger?: Pick<AppLogger, "warn">;
      newImageId?: () => string;
    },
  ) {}

  async accept(input: { workspaceId: string; conversationId: string; bytes: Buffer }): Promise<
    { kept: true; imageId: string } | { kept: false; reason: ToolImageIntakeDropReason }
  > {
    if (input.bytes.length > TOOL_IMAGE_LIMITS.maxInlineBytes) return { kept: false, reason: "too_large" };
    const type = sniffImageType(input.bytes, TOOL_IMAGE_TYPES);
    if (!type) return { kept: false, reason: "unsupported_type" };
    const imageId = (this.deps.newImageId ?? randomUUID)();
    try {
      await this.deps.objects.put({ workspaceId: input.workspaceId, imageId, suffix: "source", bytes: input.bytes, mimeType: type });
      await this.deps.rows.insertInline({
        id: imageId,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        object: this.deps.objects.locate({ workspaceId: input.workspaceId, imageId, suffix: "source" }),
      });
    } catch (error) {
      this.deps.logger?.warn({ workspaceId: input.workspaceId, conversationId: input.conversationId, errorClass: errorClassOf(error) }, "tool_image_intake_failed");
      return { kept: false, reason: "store_failed" };
    }
    return { kept: true, imageId };
  }
}
