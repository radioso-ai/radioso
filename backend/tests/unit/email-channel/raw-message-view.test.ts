import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildRawMessageView,
  type RawMessageRedaction,
} from "../../../src/modules/emailChannel/content/rawMessageView.js";

const MIME = fileURLToPath(new URL("../../fixtures/email-channel/mime/", import.meta.url));
const PROTOCOL = fileURLToPath(new URL("../../fixtures/email-channel/protocol/", import.meta.url));
const RELAY_TOKEN = "QZ2K7XN4VTM3RLHJWPC6YGBSFD";

const redaction: RawMessageRedaction = {
  relayDomains: ["in.relay.test"],
  mailboxAddresses: ["support@customer.test"],
};

const viewOf = (path: string, truncated = false) =>
  buildRawMessageView({ raw: readFileSync(path), truncated }, redaction);

const htmlMessage = (html: string): Buffer =>
  Buffer.from(
    [
      "From: Erin Shaw <erin@example.test>",
      "To: support@customer.test",
      "Subject: Styled message",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      "",
    ].join("\r\n"),
  );

const sanitizedHtmlOf = async (html: string): Promise<string> => {
  const view = await buildRawMessageView({ raw: htmlMessage(html), truncated: false }, redaction);
  return view.sanitizedHtml ?? "";
};

const headerNames = (headers: readonly { name: string }[]) => headers.map((header) => header.name.toLowerCase());

describe("buildRawMessageView: HTML sanitization", () => {
  it("drops scripts and their content", async () => {
    const html = await sanitizedHtmlOf('<p>Visible</p><script>window.stolen = document.cookie</script>');

    expect(html).toContain("Visible");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("document.cookie");
  });

  it("drops event handler attributes", async () => {
    const html = await sanitizedHtmlOf(
      '<p onclick="steal()" onmouseover="steal()">Hover</p><img src="cid:logo" onerror="steal()">',
    );

    expect(html).toContain("Hover");
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toContain("steal()");
  });

  it("drops forms and their controls but keeps the surrounding text", async () => {
    const html = await sanitizedHtmlOf(
      '<form action="https://phish.example.test/login" method="post"><label>Password</label><input type="password" name="p"><button type="submit">Sign in</button><select><option>Secret option</option></select><textarea>Prefilled</textarea></form>',
    );

    expect(html).not.toMatch(/<(form|input|button|select|option|textarea)\b/i);
    expect(html).not.toContain("phish.example.test");
    expect(html).not.toContain("Secret option");
    expect(html).toContain("Password");
  });

  it("drops remote resources and every URL that is not cid: or mailto:", async () => {
    const html = await sanitizedHtmlOf(
      [
        '<img src="https://tracker.example.test/open.gif" alt="pixel">',
        '<img src="//tracker.example.test/proto.gif">',
        '<img src="/relative/track.gif">',
        '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
        '<img srcset="https://tracker.example.test/2x.gif 2x">',
        '<link rel="stylesheet" href="https://tracker.example.test/style.css">',
        '<iframe src="https://tracker.example.test/frame"></iframe>',
        '<table background="https://tracker.example.test/bg.gif"><tr><td>Cell</td></tr></table>',
        '<a href="https://shop.example.test/order/1">Order link</a>',
        '<a href="javascript:alert(1)">Script link</a>',
        '<a href="mailto:help@example.test">Write to us</a>',
      ].join(""),
    );

    expect(html).not.toContain("tracker.example.test");
    expect(html).not.toContain("/relative/track.gif");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("shop.example.test");
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<(iframe|link)\b/i);
    expect(html).toContain("Order link");
    expect(html).toContain("Cell");
    expect(html).toContain('href="mailto:help@example.test"');
  });

  it("keeps cid: images as placeholders for inline parts", async () => {
    const html = await sanitizedHtmlOf('<p>Logo:</p><img src="cid:logo@example.test" alt="Company logo">');

    expect(html).toMatch(/<img[^>]*src="cid:logo@example\.test"/);
    expect(html).toContain('alt="Company logo"');
  });

  it("removes url() from styles and drops style elements, keeping safe declarations", async () => {
    const html = await sanitizedHtmlOf(
      [
        "<style>body { background: url(https://tracker.example.test/css.gif) }</style>",
        '<div style="background-image: url(https://tracker.example.test/bg.gif); color: red">Styled</div>',
        '<div style="background: url(\'https://tracker.example.test/short.gif\')">Shorthand</div>',
        '<div style="color: \\75 rl(https://tracker.example.test/escaped.gif)">Escaped</div>',
      ].join(""),
    );

    expect(html).not.toMatch(/url\s*\(/i);
    expect(html).not.toContain("tracker.example.test");
    expect(html).not.toMatch(/<style/i);
    expect(html).toMatch(/style="color:\s*red;?"/);
    expect(html).toContain("Styled");
    expect(html).toContain("Shorthand");
  });

  it("is null when the message has no HTML part, and the plain text is shown", async () => {
    const view = await viewOf(`${MIME}first-contact.eml`);

    expect(view.sanitizedHtml).toBeNull();
    expect(view.text).toContain("update my billing address");
  });
});

describe("buildRawMessageView: headers", () => {
  it("shows the display-safe headers and hides the relay hops", async () => {
    const view = await viewOf(`${MIME}first-contact.eml`);

    expect(headerNames(view.headers)).toEqual(
      expect.arrayContaining(["from", "to", "subject", "date", "message-id"]),
    );
    for (const hidden of ["delivered-to", "received", "x-forwarded-to", "x-forwarded-for", "return-path"]) {
      expect(headerNames(view.headers)).not.toContain(hidden);
    }
    expect(JSON.stringify(view.headers)).not.toContain(RELAY_TOKEN);
  });

  it("hides any header that names a relay address", async () => {
    const view = await viewOf(`${PROTOCOL}dsn-radioso-id.eml`);

    expect(headerNames(view.headers)).toContain("from");
    expect(headerNames(view.headers)).not.toContain("to");
    expect(JSON.stringify(view.headers)).not.toContain(RELAY_TOKEN);
  });

  it("hides any header that names a plus-addressed thread token of a mailbox", async () => {
    const view = await viewOf(`${MIME}token-only-reply.eml`);

    expect(headerNames(view.headers)).toContain("from");
    expect(headerNames(view.headers)).not.toContain("to");
    expect(JSON.stringify(view.headers)).not.toContain("thrA7k2m9qzx4p");
  });

  it("keeps a sender's own plus address, which is not a mailbox thread token", async () => {
    const raw = Buffer.from(
      "From: Alice <alice+shop@example.test>\r\nTo: support@customer.test\r\nSubject: Hi\r\n\r\nBody\r\n",
    );

    const view = await buildRawMessageView({ raw, truncated: false }, redaction);

    expect(view.headers).toContainEqual({ name: "From", value: "Alice <alice+shop@example.test>" });
    expect(view.headers).toContainEqual({ name: "To", value: "support@customer.test" });
  });

  it("decodes encoded words in header values", async () => {
    const view = await viewOf(`${MIME}encoded-word-subject.eml`);

    expect(view.headers).toContainEqual({
      name: "Subject",
      value: "Rückfrage zu Bestellung: Preise für zwei Büros",
    });
  });

  it("shows the automation headers classification reads", async () => {
    const view = await viewOf(`${PROTOCOL}list-id.eml`);

    expect(headerNames(view.headers)).toContain("list-id");
  });
});

describe("buildRawMessageView: attachments and truncation", () => {
  it("lists the attachments manifest without content", async () => {
    const view = await viewOf(`${MIME}attachments.eml`);

    expect(view.attachments).toEqual([
      { name: "order-summary.txt", contentType: "text/plain", sizeBytes: 73 },
      { name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 125 },
    ]);
  });

  it("reports whether the stored raw body was truncated", async () => {
    const whole = await viewOf(`${MIME}first-contact.eml`, false);
    const truncated = await viewOf(`${MIME}first-contact.eml`, true);

    expect(whole.truncated).toBe(false);
    expect(truncated.truncated).toBe(true);
  });

  it("renders what survives of a raw body cut at the storage cap", async () => {
    const raw = readFileSync(`${MIME}attachments.eml`);
    const cut = raw.subarray(0, raw.indexOf("JVBERi0x") + 20);

    const view = await buildRawMessageView({ raw: cut, truncated: true }, redaction);

    expect(view.truncated).toBe(true);
    expect(headerNames(view.headers)).toContain("subject");
    expect(view.text).toContain("attaching my order summary");
  });
});
