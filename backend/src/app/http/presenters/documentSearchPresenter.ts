import { z } from "zod";

export const includeDebugQuerySchema = z.object({
  includeDebug: z.enum(["true", "false"]).optional().transform((value) => value === "true"),
});

export const presentDocumentSearchResponse = <T extends { activityTrace?: unknown }>(
  result: T,
  includeDebug: boolean,
) => {
  const { activityTrace, ...response } = result;
  return {
    ...response,
    ...(includeDebug && activityTrace ? { debug: { activityTrace } } : {}),
  };
};
