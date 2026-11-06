import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";

import {
  generateStaffSessionToken,
  hashStaffPassword,
  hashStaffSessionToken,
  verifyStaffPassword,
} from "./staffCrypto.js";

describe("staffCrypto", () => {
  it("hashes and verifies staff passwords with bcrypt", async () => {
    const hash = await hashStaffPassword("correct horse battery staple");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    await expect(verifyStaffPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyStaffPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("spends a real bcrypt comparison when there is no stored password to check", async () => {
    const compare = vi.spyOn(bcrypt, "compare");

    await expect(verifyStaffPassword("any-password", null)).resolves.toBe(false);

    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it("generates opaque tokens and stores only sha256 hashes", () => {
    const token = generateStaffSessionToken();
    const tokenHash = hashStaffSessionToken(token);

    expect(token).not.toEqual(generateStaffSessionToken());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).toBe(hashStaffSessionToken(token));
  });

  it("does not reach into OSS auth primitives", async () => {
    const source = await readFile(resolve("src/staffConsole/staffCrypto.ts"), "utf8");

    expect(source).not.toContain("backend/src");
    expect(source).not.toContain("authPrimitives");
  });
});
