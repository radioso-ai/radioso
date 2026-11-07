import { describe, expect, it, vi } from "vitest";

import { HttpError } from "../shared/httpError.js";
import type { StaffBootstrapResult } from "./staffBootstrap.js";
import { runStaffBootstrapCommand } from "./staffBootstrapCommand.js";
import type { StaffUser } from "./staffTypes.js";

type BootstrapOwner = () => Promise<StaffBootstrapResult>;

const staff = { id: "11111111-1111-1111-8111-111111111111" } as StaffUser;

const run = async (input: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  bootstrapOwner?: BootstrapOwner;
}) => {
  const out: string[] = [];
  const err: string[] = [];
  const bootstrapOwner = vi.fn(input.bootstrapOwner
    ?? (async () => ({ staff, action: "create_owner" as const, revokedSessions: 0 })));
  const close = vi.fn(async () => undefined);
  const createBootstrapService = vi.fn(() => ({ service: { bootstrapOwner }, close }));
  const exitCode = await runStaffBootstrapCommand({
    argv: input.argv ?? ["--email", "ops@example.com", "--name", "Ops"],
    env: input.env ?? {
      DATABASE_URL: "postgresql://db.invalid/radioso",
      STAFF_BOOTSTRAP_PASSWORD: "a-long-enough-secret",
    },
    createBootstrapService,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { exitCode, out, err, bootstrapOwner, close, createBootstrapService };
};

describe("staff bootstrap command", () => {
  it("creates the owner and reports the id, never the password", async () => {
    const { exitCode, out, err, bootstrapOwner, close } = await run({});

    expect(exitCode).toBe(0);
    expect(bootstrapOwner).toHaveBeenCalledWith({
      email: "ops@example.com",
      name: "Ops",
      password: "a-long-enough-secret",
    });
    expect(out.join("\n")).toContain(staff.id);
    expect(`${out.join("\n")}${err.join("\n")}`).not.toContain("a-long-enough-secret");
    expect(close).toHaveBeenCalledOnce();
  });

  it("names the ended sessions when it resets an owner", async () => {
    const { exitCode, out } = await run({
      bootstrapOwner: async () => ({ staff, action: "reset_owner", revokedSessions: 3 }),
    });

    expect(exitCode).toBe(0);
    expect(out.join("\n")).toContain("3");
  });

  it.each([
    ["no email", { argv: ["--name", "Ops"] }],
    ["an unrecognised flag", { argv: ["--email", "ops@example.com", "--name", "Ops", "--password", "x"] }],
    ["a malformed email", { argv: ["--email", "nope", "--name", "Ops"] }],
    ["no database", { env: { STAFF_BOOTSTRAP_PASSWORD: "a-long-enough-secret" } }],
    ["no password", { env: { DATABASE_URL: "postgresql://db.invalid/radioso" } }],
    ["a short password", { env: { DATABASE_URL: "postgresql://db.invalid/radioso", STAFF_BOOTSTRAP_PASSWORD: "elevenchars" } }],
  ])("exits 2 without touching the database on %s", async (_label, input) => {
    const { exitCode, err, createBootstrapService } = await run(input);

    expect(exitCode).toBe(2);
    expect(err.join("\n")).not.toBe("");
    expect(createBootstrapService).not.toHaveBeenCalled();
  });

  it("exits 1 with the refusal and still closes the database", async () => {
    const { exitCode, err, close } = await run({
      bootstrapOwner: async () => {
        throw new HttpError(409, "staff_bootstrap_conflict", "Bootstrap can only reset an existing owner.");
      },
    });

    expect(exitCode).toBe(1);
    expect(err.join("\n")).toContain("Bootstrap can only reset an existing owner.");
    expect(close).toHaveBeenCalledOnce();
  });
});
