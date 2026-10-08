import type { EmailService } from "../../modules/mail/emailService.js";
import { renderEmail, renderEmailText, type EmailContent } from "../../modules/mail/templates/layout.js";
import type { ApplicationNoticeEmailContent, ApplicationNoticeMailPort } from "./applicationModule.js";

const toEmailContent = (content: ApplicationNoticeEmailContent): EmailContent => ({
  preheader: content.preheader,
  heading: content.heading,
  paragraphs: [...content.paragraphs],
  ...(content.cta ? { cta: content.cta } : {}),
  ...(content.metaRows ? { metaRows: [...content.metaRows] } : {}),
  ...(content.footnote ? { footnote: content.footnote } : {}),
});

/**
 * The default `ApplicationNoticeMailPort`: a module hands over neutral content and a `kind`;
 * this renders it with the shared brand layout (`modules/mail/templates/layout.ts`) and sends
 * it through `EmailService`, so a usage alert looks like every other Radioso email without the
 * contributing module importing OSS template code.
 */
export const createNoticeMailAdapter = (
  mailService: Pick<EmailService, "send">,
  options: { appBaseUrl?: string | null } = {},
): ApplicationNoticeMailPort => ({
  async send(input) {
    const content = toEmailContent(input.content);
    await mailService.send({
      to: input.to,
      subject: input.subject,
      text: renderEmailText(content),
      html: renderEmail(content, { appBaseUrl: options.appBaseUrl }),
      kind: input.kind,
    });
  },
});
