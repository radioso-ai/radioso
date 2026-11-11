import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

/**
 * How a recorded user message was produced. `routine_invocation` is a calling agent's tool call:
 * `routine` carries its structured form for tool-call rendering while `content` holds the same
 * call as text. `imageInput` is a message's photos: `content` holds the visitor's text followed by
 * one `<visitor_image>` block per photo, the turn text the agent ran on, while `typedText` is what
 * the visitor typed and each image carries what the agent's model read in it.
 */
export const registerUserMessageInputMetadataSchema = (registry: OpenAPIRegistry) => {
  const VisitorImageInputSchema = registry.register(
    "VisitorImageInput",
    z.object({
      typedText: z.string().openapi({ description: "What the visitor typed, without the photo readings. Empty when they sent photos alone." }),
      images: z.array(z.object({
        id: z.string().uuid().openapi({ description: "The image id; read the photo from the conversation's image route." }),
        reading: z.string().nullable().openapi({ description: "What the agent's chat model read in the photo, in the visitor's language; null when it could not read it." }),
      })).min(1).max(3),
    }).openapi({
      description: "The photos a message carries. Render `typedText` and the photos in the visitor's bubble; the readings are the agent's, not the visitor's words.",
    }),
  );

  return registry.register(
    "UserMessageInputMetadata",
    z.object({
      method: z.enum(["typed", "suggestion_click", "intent_click", "routine_invocation"]),
      suggestionSourceMessageId: z.string().uuid().optional(),
      intent: z.object({
        skillName: z.string(),
        intentName: z.string().optional(),
      }).optional(),
      routine: z.object({
        toolName: z.string(),
        input: z.record(z.string(), z.unknown()),
      }).optional(),
      imageInput: VisitorImageInputSchema.optional(),
    }),
  );
};
