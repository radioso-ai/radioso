import { resolveTxt } from "node:dns/promises";

import type { parseEmailChannelConfig } from "../../config/env.js";
import {
  LOCAL_EMAIL_SPOOL_DIR,
  LocalEmailDomainProvisioner,
  LocalEmailDriver,
  LocalInboundEmailReceiver,
  ResendApiClient,
  ResendEmailDomainProvisioner,
  ResendEmailDriver,
  ResendInboundEmailReceiver,
  type EmailDomainProvisioner,
  type EmailDriver,
  type InboundEmailReceiver,
} from "../../../modules/mail/public.js";

export type EmailChannelConfig = NonNullable<ReturnType<typeof parseEmailChannelConfig>>;

/** The provider the channel's adapters are built for: Resend's account, or the local spool. */
export type ChannelProvider =
  | Extract<EmailChannelConfig["provider"], { kind: "resend" }>
  | { kind: "local"; spoolDir: string };

/** The configured provider; the local one spools to `localSpoolDir`, or to `LOCAL_EMAIL_SPOOL_DIR` without it. */
export const channelProviderOf = (config: EmailChannelConfig, localSpoolDir: string | undefined): ChannelProvider =>
  config.provider.kind === "resend"
    ? config.provider
    : { kind: "local", spoolDir: localSpoolDir ?? LOCAL_EMAIL_SPOOL_DIR };

/** The provider's webhook receiver, verifying with the current and previous signing secrets, and its domain provisioner. */
export const providerAdapters = (
  config: EmailChannelConfig,
  provider: ChannelProvider,
): { receiver: InboundEmailReceiver; provisioner: EmailDomainProvisioner } => {
  const signingSecrets = { current: config.webhookSecret, previous: config.previousWebhookSecret ?? null };
  if (provider.kind === "resend") {
    const api = new ResendApiClient({ apiKey: provider.apiKey });
    return {
      receiver: new ResendInboundEmailReceiver({ api, signingSecrets }),
      provisioner: new ResendEmailDomainProvisioner({ api, region: provider.region, resolveTxt: (hostname) => resolveTxt(hostname) }),
    };
  }
  return {
    receiver: new LocalInboundEmailReceiver({ spoolDir: provider.spoolDir, signingSecrets }),
    provisioner: new LocalEmailDomainProvisioner({ spoolDir: provider.spoolDir }),
  };
};

/** The channel's sending driver, separate from transactional mail's (quickstart §1). */
export const channelEmailDriver = (provider: ChannelProvider): EmailDriver =>
  provider.kind === "resend"
    ? new ResendEmailDriver({ api: new ResendApiClient({ apiKey: provider.apiKey }) })
    : new LocalEmailDriver({ spoolDir: provider.spoolDir });
