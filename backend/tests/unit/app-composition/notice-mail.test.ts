import { describe, expect, it, vi } from "vitest";

import { createNoticeMailAdapter } from "../../../src/app/composition/noticeMail.js";

describe("createNoticeMailAdapter", () => {
  it("renders the branded layout and sends with the usage_alert kind tag", async () => {
    const mailService = { send: vi.fn().mockResolvedValue({ dispatched: true }) };
    const adapter = createNoticeMailAdapter(mailService, { appBaseUrl: "https://app.example.com" });

    await adapter.send({
      to: "admin@example.com",
      subject: "This month's conversations are used up",
      kind: "usage_alert",
      content: {
        preheader: "80% of this month's conversations used.",
        heading: "You're nearing your conversation limit",
        paragraphs: ["You've used 400 of 500 conversations this month."],
        cta: { href: "https://app.example.com/account/acc_1/account?tab=usage", label: "Upgrade" },
      },
    });

    expect(mailService.send).toHaveBeenCalledTimes(1);
    const sent = mailService.send.mock.calls[0][0];
    expect(sent.to).toBe("admin@example.com");
    expect(sent.subject).toBe("This month's conversations are used up");
    expect(sent.kind).toBe("usage_alert");
    expect(sent.text).toContain("You've used 400 of 500 conversations this month.");
    expect(sent.text).toContain("https://app.example.com/account/acc_1/account?tab=usage");
    expect(sent.html).toContain("You&#39;re nearing your conversation limit");
    expect(sent.html).toContain("https://app.example.com/account/acc_1/account?tab=usage");
  });

  it("omits the call to action and meta rows when the content leaves them out", async () => {
    const mailService = { send: vi.fn().mockResolvedValue({ dispatched: true }) };
    const adapter = createNoticeMailAdapter(mailService);

    await adapter.send({
      to: "admin@example.com",
      subject: "Your agents stopped answering visitors",
      kind: "usage_alert",
      content: {
        preheader: "Visitors are not getting answers right now.",
        heading: "Your agents stopped answering visitors",
        paragraphs: ["Visitors now see an unavailable message."],
      },
    });

    const sent = mailService.send.mock.calls[0][0];
    expect(sent.text).toBe(
      [
        "Your agents stopped answering visitors",
        "Visitors now see an unavailable message.",
        "Radioso — All your conversational agents. One platform you own.\nhttps://radioso.ai",
      ].join("\n\n"),
    );
  });
});
