import { z } from "zod";

const configSchema = z.object({
  RADIOSO_BASE_URL: z.url(),
  RADIOSO_API_TOKEN: z.string().trim().min(1),
  RADIOSO_SERVER_NAME: z.string().trim().min(1).optional(),
});

export interface RadiosoMcpConfig {
  baseUrl: string;
  apiToken: string;
  serverName: string;
}

export const loadConfig = (env: NodeJS.ProcessEnv | Record<string, string | undefined>): RadiosoMcpConfig => {
  const parsed = configSchema.parse(env);

  return {
    apiToken: parsed.RADIOSO_API_TOKEN,
    baseUrl: parsed.RADIOSO_BASE_URL.replace(/\/+$/, ""),
    serverName: parsed.RADIOSO_SERVER_NAME ?? "radioso-context",
  };
};
