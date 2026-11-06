import { parseArgs } from "node:util";

import { z } from "zod";

import type { StaffBootstrapResult } from "./staffBootstrap.js";
import { STAFF_PASSWORD_MIN_LENGTH } from "./staffCrypto.js";
import { readStaffWorkspaceDomain } from "./staffWorkspaceSignIn.js";

const USAGE = `Usage: staff:bootstrap --email <address> --name <name>, with DATABASE_URL set and either STAFF_GOOGLE_WORKSPACE_DOMAIN or a STAFF_BOOTSTRAP_PASSWORD of at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`;

const inputSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(STAFF_PASSWORD_MIN_LENGTH).nullable(),
});

interface StaffBootstrapCommandInput {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  createBootstrapService: (databaseUrl: string) => {
    service: { bootstrapOwner(input: z.infer<typeof inputSchema>): Promise<StaffBootstrapResult> };
    close(): Promise<void>;
  };
  out: (line: string) => void;
  err: (line: string) => void;
}

const readFlags = (argv: readonly string[]): { email?: string; name?: string } | null => {
  try {
    return parseArgs({
      args: [...argv],
      options: { email: { type: "string" }, name: { type: "string" } },
    }).values;
  } catch {
    return null;
  }
};

/** Exits 0 on success, 1 when the bootstrap itself is refused or fails, 2 on bad input. */
export const runStaffBootstrapCommand = async (input: StaffBootstrapCommandInput): Promise<number> => {
  const flags = readFlags(input.argv);
  // A password is useless once staff sign in with Workspace, so none is stored.
  const password = readStaffWorkspaceDomain(input.env) ? null : input.env.STAFF_BOOTSTRAP_PASSWORD;
  const parsed = inputSchema.safeParse({ ...flags, password });
  const databaseUrl = input.env.DATABASE_URL?.trim();
  if (!flags || !parsed.success || !databaseUrl) {
    input.err(USAGE);
    return 2;
  }

  const { service, close } = input.createBootstrapService(databaseUrl);
  try {
    const { staff, action, revokedSessions } = await service.bootstrapOwner(parsed.data);
    input.out(action === "reset_owner"
      ? `Reset owner ${staff.id} and ended ${revokedSessions} session(s).`
      : `Created owner ${staff.id}.`);
    return 0;
  } catch (error) {
    input.err(error instanceof Error ? error.message : "Staff bootstrap failed.");
    return 1;
  } finally {
    await close();
  }
};
