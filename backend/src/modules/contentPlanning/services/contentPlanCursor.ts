import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { AppError } from "../../../shared/domain/errors.js";
import { contentPlanViewSchema, type ContentPlanView } from "../contracts/index.js";

const contentPlanCursorPayloadSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  projectionGenerationId: z.string().uuid(),
  asOf: z.string().datetime({ offset: true }),
  view: contentPlanViewSchema,
  rankingVersion: z.literal(1),
  order: z.object({
    activeNoSupportConversationCount: z.number().int().min(0),
    activeDegradedConversationCount: z.number().int().min(0),
    currentConversationCount: z.number().int().min(0),
    trendRank: z.number().int().min(0),
    topicId: z.string().uuid(),
  }).strict(),
}).strict();

export type ContentPlanCursorPayload = z.infer<typeof contentPlanCursorPayloadSchema>;

export class ContentPlanCursorError extends AppError {
  constructor() {
    super(400, "bad_request", "Invalid content plan cursor");
    this.name = "ContentPlanCursorError";
  }
}

const invalidCursor = (): never => {
  throw new ContentPlanCursorError();
};

export class ContentPlanCursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length === 0) invalidCursor();
  }

  encode(candidate: ContentPlanCursorPayload): string {
    const parsed = contentPlanCursorPayloadSchema.safeParse(candidate);
    if (!parsed.success) return invalidCursor();
    const body = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  decode(cursor: string, expected: {
    workspaceId: string;
    view: ContentPlanView;
    projectionGenerationId: string;
  }): ContentPlanCursorPayload {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return invalidCursor();
      const [body, signature] = parts;
      const actual = Buffer.from(signature, "base64url");
      const wanted = Buffer.from(this.sign(body), "base64url");
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return invalidCursor();
      const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      const parsed = contentPlanCursorPayloadSchema.safeParse(decoded);
      if (!parsed.success) return invalidCursor();
      if (
        parsed.data.workspaceId !== expected.workspaceId
        || parsed.data.view !== expected.view
        || parsed.data.projectionGenerationId !== expected.projectionGenerationId
      ) {
        return invalidCursor();
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ContentPlanCursorError) throw error;
      return invalidCursor();
    }
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body, "utf8").digest("base64url");
  }
}
