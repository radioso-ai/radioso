import type { SkillOutcomeMedia } from "@radioso/conversation-contract";

import type { ToolImageIntakeDropReason } from "../../toolImages/contracts/index.js";

/**
 * Where the pictures one tool call returns as bytes go: kept for the conversation that called the
 * tool, or dropped with a reason. Bound per call by the executor, so the tool service never learns
 * which conversation it serves.
 */
export interface McpToolImageSink {
  keep(bytes: Buffer): Promise<{ kept: true; imageId: string } | { kept: false; reason: ToolImageIntakeDropReason }>;
  dropped(reason: ToolImageIntakeDropReason): void;
}

/** Pictures kept from one call; any past these are dropped. */
const MAX_IMAGES_PER_CALL = 4;
/** One picture's decoded size. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The types a picture may declare; its bytes are checked again when it is kept. */
const ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

interface McpImageBlock {
  type?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

/** Bytes a base64 string decodes to, without decoding it. */
const decodedLength = (base64: string): number => Math.floor((base64.replace(/=+$/, "").length * 3) / 4);

/**
 * Keeps the `image` content blocks of one MCP tool result: at most four, each at most 5 MB and of
 * a raster type, and an SVG never. What the outcome carries is only each kept picture's id; the
 * bytes stay with the sink.
 */
export const keepMcpImages = async (
  content: readonly McpImageBlock[] | undefined,
  sink: McpToolImageSink | undefined,
): Promise<SkillOutcomeMedia[]> => {
  const blocks = (content ?? []).filter((block) => block.type === "image");
  if (!sink || blocks.length === 0) return [];
  const media: SkillOutcomeMedia[] = [];
  for (const block of blocks) {
    if (media.length >= MAX_IMAGES_PER_CALL) {
      sink.dropped("over_limit");
      continue;
    }
    if (typeof block.mimeType !== "string" || !ACCEPTED_MIME_TYPES.has(block.mimeType.toLowerCase()) || typeof block.data !== "string") {
      sink.dropped("unsupported_type");
      continue;
    }
    if (decodedLength(block.data) > MAX_IMAGE_BYTES) {
      sink.dropped("too_large");
      continue;
    }
    const kept = await sink.keep(Buffer.from(block.data, "base64"));
    if (kept.kept) {
      media.push({ kind: "image", imageId: kept.imageId });
    } else {
      sink.dropped(kept.reason);
    }
  }
  return media;
};
