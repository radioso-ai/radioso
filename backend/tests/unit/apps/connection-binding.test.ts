import { describe, expect, it } from "vitest";

import { buildAppConnectionBinding } from "../../../src/modules/apps/public.js";
import { wordpressManifest } from "./support.js";

const slot = (slotId: string) => {
  const found = wordpressManifest().connections.slots.find((candidate) => candidate.id === slotId);
  if (!found) throw new Error(`missing slot ${slotId}`);
  return found;
};

describe("app connection binding", () => {
  it("keeps only non-sensitive fields readable and puts the rest in the secret payload", () => {
    const binding = buildAppConnectionBinding({
      slot: slot("site_credentials"),
      values: { wp_username: "editor", wp_application_password: "hunter2" },
      generateSecret: () => "unused",
    });

    expect(binding.publicFields).toEqual({ wp_username: "editor" });
    expect(binding.generatedSecret).toBeNull();
    expect(binding.secret).not.toBeNull();
    expect(JSON.stringify(binding.publicFields)).not.toContain("hunter2");
  });

  it("mints a generated secret server-side and returns it exactly once", () => {
    const binding = buildAppConnectionBinding({
      slot: slot("webhook_secret"),
      values: { webhook_secret: "operator-supplied" },
      generateSecret: (byteLength) => `minted-${byteLength}`,
    });

    expect(binding.generatedSecret).toBe("minted-32");
    expect(binding.secret).toBe("minted-32");
    expect(binding.publicFields).toEqual({});
    expect(JSON.stringify(binding)).not.toContain("operator-supplied");
  });

  it("refuses a binding that omits a required field or names an undeclared one", () => {
    expect(() => buildAppConnectionBinding({
      slot: slot("site_credentials"),
      values: { wp_username: "editor" },
      generateSecret: () => "unused",
    })).toThrow(expect.objectContaining({ reason: "connection_invalid" }));

    expect(() => buildAppConnectionBinding({
      slot: slot("site_credentials"),
      values: { wp_username: "editor", wp_application_password: "hunter2", extra: "x" },
      generateSecret: () => "unused",
    })).toThrow(expect.objectContaining({ reason: "connection_invalid" }));
  });
});
