import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { getEnv, parseEmailChannelConfig } from "../src/app/config/env.js";
import { LocalEmailDomainProvisioner } from "../src/modules/mail/adapters/localDomainProvisioner.js";
import { LocalEmailDriver } from "../src/modules/mail/adapters/localEmailDriver.js";
import { LOCAL_EMAIL_SPOOL_DIR } from "../src/modules/mail/adapters/localSpool.js";
import { normalizeInboundMime } from "../src/modules/mail/public.js";
import { loadEnvFileIfPresent } from "../src/runtime/loadEnv.js";

/**
 * Development driver for the email channel's `local` provider (quickstart §3). It stands in for
 * the provider: it spools a message where the local receiver reads it and posts the signed
 * `email.received` webhook to the running API, posts the delivery events of mail the local driver
 * sent, and verifies local domains. Never part of a deployed runtime; it refuses to run in
 * production or against another provider.
 *
 *   pnpm run email:dev -- inbound <file.eml> [--relay <relay address>]... [--url <api base>]
 *   pnpm run email:dev -- inbound --replay <svix-id> [--url <api base>]
 *   pnpm run email:dev -- delivery (--intent <send intent id> | --email-id <provider id>) --type <event> [--url <api base>]
 *   pnpm run email:dev -- verify-domain <domain>
 */

/** The outbound statuses Resend posts as `email.<type>` (research A6). */
const DELIVERY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
]);
type DeliveryEventType = "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "suppressed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = [
  "Usage:",
  "  pnpm run email:dev -- inbound <file.eml> [--relay <relay address>]... [--url <api base>]",
  "  pnpm run email:dev -- inbound --replay <svix-id> [--url <api base>]",
  "  pnpm run email:dev -- delivery (--intent <send intent id> | --email-id <provider id>) --type <event> [--url <api base>]",
  `    <event>: ${[...DELIVERY_EVENT_TYPES].join(", ")}`,
  "  pnpm run email:dev -- verify-domain <domain>",
].join("\n");

const WEBHOOK_PATH = "/api/connectors/email/webhook";
/** Webhook ids name files in the spool, so they must be plain file names. */
const SVIX_ID = /^[A-Za-z0-9_-]{1,128}$/;

type LocalChannel = { spoolDir: string; webhookSecret: string; port: number };

function fail(message: string): never {
  throw new Error(message);
}

const localChannel = (): LocalChannel => {
  loadEnvFileIfPresent();
  const env = getEnv();
  if (env.NODE_ENV === "production") fail("email:dev is a development tool and does not run in production.");
  const config = parseEmailChannelConfig(env);
  if (config?.provider.kind !== "local") fail("email:dev drives the local provider; set EMAIL_CHANNEL_PROVIDER=local.");
  return { spoolDir: LOCAL_EMAIL_SPOOL_DIR, webhookSecret: config.webhookSecret, port: env.PORT };
};

const webhooksDir = (channel: LocalChannel) => join(channel.spoolDir, "webhooks");

/** The Svix signature headers Resend sends, over this exact body. */
const signedHeaders = (secret: string, svixId: string, body: string): Record<string, string> => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  const signature = createHmac("sha256", key).update(`${svixId}.${timestamp}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": svixId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
};

const post = async (channel: LocalChannel, url: string | undefined, svixId: string, body: string): Promise<void> => {
  const target = new URL(WEBHOOK_PATH, url ?? `http://localhost:${channel.port}`);
  const response = await fetch(target, { method: "POST", headers: signedHeaders(channel.webhookSecret, svixId, body), body });
  process.stdout.write(`POST ${target.pathname} -> ${response.status} (svix-id ${svixId})\n`);
  if (!response.ok) process.exitCode = 1;
};

/** Prepends each relay address as a `Delivered-To` header, as the provider's MTA would. */
const withDeliveredTo = (raw: Buffer, relays: readonly string[]): Buffer => {
  if (relays.length === 0) return raw;
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  return Buffer.concat([Buffer.from(relays.map((relay) => `Delivered-To: ${relay}${newline}`).join("")), raw]);
};

const sendInbound = async (channel: LocalChannel, file: string, relays: readonly string[], url: string | undefined) => {
  const raw = withDeliveredTo(await readFile(file), relays);
  const message = await normalizeInboundMime(raw, {
    receivedFor: relays,
    authentication: { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
    spamVerdict: "unknown",
  });
  const emailId = `local-${randomUUID()}`;
  await mkdir(webhooksDir(channel), { recursive: true });
  await writeFile(join(channel.spoolDir, `${emailId}.eml`), raw);

  const createdAt = new Date().toISOString();
  const body = JSON.stringify({
    type: "email.received",
    created_at: createdAt,
    data: {
      email_id: emailId,
      created_at: createdAt,
      from: message.from?.address ?? null,
      to: message.to,
      cc: message.cc,
      received_for: relays,
      message_id: message.rfcMessageId,
      subject: message.subject,
    },
  });
  const svixId = `msg_${randomUUID().replaceAll("-", "")}`;
  await writeFile(join(webhooksDir(channel), `${svixId}.json`), body);
  process.stdout.write(`Spooled ${emailId}.eml\n`);
  await post(channel, url, svixId, body);
};

/** The provider detail Resend attaches to a bounce or suppression; a bounce message names no address here. */
const deliveryDetail = (type: DeliveryEventType): Record<string, unknown> => {
  if (type === "bounced") {
    return { bounce: { type: "Permanent", subType: "General", message: "550 5.1.1 The recipient mailbox does not exist." } };
  }
  return type === "suppressed" ? { suppressed: { type: "OnAccountSuppressionList" } } : {};
};

/**
 * Posts a delivery event for mail the local driver sent, as the provider would, after recording it
 * where the driver's `lookup` reads it, so the webhook and the reconciler agree.
 */
const sendDelivery = async (
  channel: LocalChannel,
  target: { intentId: string | undefined; emailId: string | undefined },
  type: DeliveryEventType,
  url: string | undefined,
) => {
  const driver = new LocalEmailDriver({ spoolDir: channel.spoolDir });
  if (target.intentId !== undefined && !UUID.test(target.intentId)) fail("--intent takes a send intent id (a UUID).");
  const emailId = target.emailId
    ?? (target.intentId === undefined ? fail(USAGE) : await driver.findByMessageIdLocalPart(target.intentId.toLowerCase()))
    ?? fail(`The local spool holds no message sent for send intent ${target.intentId ?? ""}.`);
  if (!(await driver.recordEvent(emailId, type))) fail(`The local spool holds no message ${emailId}.`);

  const createdAt = new Date().toISOString();
  const body = JSON.stringify({ type: `email.${type}`, created_at: createdAt, data: { email_id: emailId, created_at: createdAt, ...deliveryDetail(type) } });
  const svixId = `msg_${randomUUID().replaceAll("-", "")}`;
  await mkdir(webhooksDir(channel), { recursive: true });
  await writeFile(join(webhooksDir(channel), `${svixId}.json`), body);
  await post(channel, url, svixId, body);
};

const replayInbound = async (channel: LocalChannel, svixId: string, url: string | undefined) => {
  if (!SVIX_ID.test(svixId)) fail("A svix-id is letters, digits, '_' and '-' only.");
  const body = await readFile(join(webhooksDir(channel), `${svixId}.json`), "utf8").catch(() =>
    fail(`No webhook ${svixId} was sent by email:dev from this spool.`));
  await post(channel, url, svixId, body);
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    // pnpm passes its `--` separator through.
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: {
      "email-id": { type: "string" },
      fixture: { type: "string" },
      intent: { type: "string" },
      relay: { type: "string", multiple: true },
      replay: { type: "string" },
      type: { type: "string" },
      url: { type: "string" },
    },
  });
  const [command, argument] = positionals;

  if (command === "inbound") {
    const channel = localChannel();
    if (values.replay) {
      await replayInbound(channel, values.replay, values.url);
      return;
    }
    const file = values.fixture ?? argument ?? fail(USAGE);
    await sendInbound(channel, file, values.relay ?? [], values.url);
    return;
  }
  if (command === "delivery") {
    const type = values.type;
    if (type === undefined || !isDeliveryEventType(type)) fail(USAGE);
    await sendDelivery(localChannel(), { intentId: values.intent, emailId: values["email-id"] }, type, values.url);
    return;
  }
  if (command === "verify-domain") {
    const domain = argument ?? fail(USAGE);
    const channel = localChannel();
    await new LocalEmailDomainProvisioner({ spoolDir: channel.spoolDir }).markVerified(domain);
    process.stdout.write(`Marked ${domain} verified; the next readiness check reads it.\n`);
    return;
  }
  fail(USAGE);
};

function isDeliveryEventType(value: string): value is DeliveryEventType {
  return DELIVERY_EVENT_TYPES.has(value);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "email:dev failed"}\n`);
  process.exitCode = 1;
});
