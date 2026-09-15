import { describe, expect, it } from "vitest";

import {
  customerEmailExposedInputsSchema,
  customerEmailSkillDefinitionCreateSchema,
  customerEmailSkillDefinitionUpdateSchema,
  customerEmailSkillOutcomes,
} from "../../../src/modules/customerEmail/public.js";

describe("customer email skill definition domain", () => {
  it("accepts a draft skill when required fields are either bound or exposed", () => {
    const parsed = customerEmailSkillDefinitionCreateSchema.parse({
      skillName: "support_email_customer",
      connectionId: "11111111-1111-4111-8111-111111111111",
      mode: "draft",
      boundInputs: {
        replyTo: "support@example.com",
        subject: "Support follow-up",
      },
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
        bodyText: { slotBinding: "emailBody" },
      },
      enabled: true,
    });

    expect(parsed).toMatchObject({
      skillName: "support_email_customer",
      mode: "draft",
      enabled: true,
    });
    expect(customerEmailSkillOutcomes).toContain("drafted");
    expect(customerEmailSkillOutcomes).toContain("sent");
  });

  it("rejects overlapping bound and exposed inputs", () => {
    const result = customerEmailSkillDefinitionCreateSchema.safeParse({
      skillName: "support_email_customer",
      connectionId: "11111111-1111-4111-8111-111111111111",
      mode: "draft",
      boundInputs: {
        to: "customer@example.com",
        subject: "Follow-up",
      },
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
        bodyText: { slotBinding: "emailBody" },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toContain("disjoint");
  });

  it("requires every required email input to be bound or exposed", () => {
    const result = customerEmailSkillDefinitionCreateSchema.safeParse({
      skillName: "support_email_customer",
      connectionId: "11111111-1111-4111-8111-111111111111",
      mode: "draft",
      boundInputs: {
        subject: "Follow-up",
      },
      exposedInputs: {
        to: { slotBinding: "customerEmail" },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join("\n")).toContain("bodyText or bodyHtml");
  });

  it("validates send mode and patch payloads with the same input rules", () => {
    expect(() =>
      customerEmailSkillDefinitionCreateSchema.parse({
        skillName: "support.email_customer",
        connectionId: "11111111-1111-4111-8111-111111111111",
        mode: "send",
        boundInputs: {
          to: "customer@example.com",
          subject: "Follow-up",
          bodyText: "Thanks for contacting us.",
        },
      }),
    ).toThrow();

    const patch = customerEmailSkillDefinitionUpdateSchema.safeParse({
      mode: "send",
      boundInputs: {
        subject: "Follow-up",
      },
      exposedInputs: {
        subject: { slotBinding: "emailSubject" },
      },
    });

    expect(patch.success).toBe(false);
  });
});

describe("customerEmailExposedInputsSchema (exposed input spec)", () => {
  it("accepts an exposed input spec with required: true", () => {
    const parsed = customerEmailExposedInputsSchema.parse({
      to: { description: "Recipient", slotBinding: "customerEmail", required: true },
    });
    expect(parsed.to?.required).toBe(true);
  });

  it("accepts an exposed input spec with required: false", () => {
    const parsed = customerEmailExposedInputsSchema.parse({
      to: { description: "Recipient", slotBinding: "customerEmail", required: false },
    });
    expect(parsed.to?.required).toBe(false);
  });

  it("rejects a non-boolean required", () => {
    expect(() => customerEmailExposedInputsSchema.parse({ to: { required: "yes" } })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => customerEmailExposedInputsSchema.parse({ to: { required: true, surprise: 1 } })).toThrow();
  });
});
