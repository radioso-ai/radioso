import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalEmailDomainProvisioner } from "../../../src/modules/mail/adapters/localDomainProvisioner.js";
import { LocalInboundEmailReceiver } from "../../../src/modules/mail/adapters/localInboundReceiver.js";
import { LOCAL_EMAIL_SPOOL_DIR } from "../../../src/modules/mail/adapters/localSpool.js";
import { InboundFetchError } from "../../../src/modules/mail/public.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/email-channel/", import.meta.url));
const CURRENT_SECRET = "whsec_bG9jYWwtZGV2LXNlY3JldC0wMDAwMDAwMDAwMDA=";
const PREVIOUS_SECRET = `whsec_${Buffer.from("previous-local-secret-000000").toString("base64")}`;
const NOW = new Date("2026-10-03T13:32:30.000Z");

const signatureFor = (secret: string, id: string, timestamp: number, body: Buffer): string => {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest("base64");
  return `v1,${digest}`;
};

const receivedEvent = (): Buffer =>
  Buffer.from(
    JSON.stringify({
      type: "email.received",
      created_at: "2026-10-03T13:32:29.870Z",
      data: {
        email_id: "local-0001",
        created_at: "2026-10-03T13:32:29.870Z",
        from: "alice@example.test",
        to: ["support@customer.test"],
        cc: [],
        received_for: ["QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test"],
        message_id: "<msg-0001@example.test>",
        subject: "Question about my account",
      },
    }),
  );

const signedHeaders = (secret: string, body: Buffer, at: Date = NOW) => {
  const timestamp = Math.floor(at.getTime() / 1000);
  return {
    "svix-id": "msg_local_0001",
    "svix-timestamp": String(timestamp),
    "svix-signature": signatureFor(secret, "msg_local_0001", timestamp, body),
  };
};

describe("local inbound email receiver", () => {
  let spoolDir: string;
  let receiver: LocalInboundEmailReceiver;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), "email-spool-"));
    receiver = new LocalInboundEmailReceiver({
      spoolDir,
      signingSecrets: { current: CURRENT_SECRET, previous: PREVIOUS_SECRET },
    });
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it("names itself the local provider", () => {
    expect(receiver.provider).toBe("local");
  });

  it("verifies an event signed with the current secret", () => {
    const rawBody = receivedEvent();

    const result = receiver.verify({ rawBody, headers: signedHeaders(CURRENT_SECRET, rawBody), now: NOW });

    expect(result).toEqual({
      ok: true,
      event: {
        kind: "message_received",
        providerEventId: "msg_local_0001",
        providerObjectId: "local-0001",
        occurredAt: new Date("2026-10-03T13:32:29.870Z"),
        envelope: {
          from: "alice@example.test",
          to: ["support@customer.test"],
          cc: [],
          receivedFor: ["QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test"],
          subject: "Question about my account",
          rfcMessageId: "<msg-0001@example.test>",
        },
      },
    });
  });

  it("verifies an event signed with the previous secret during rotation", () => {
    const rawBody = receivedEvent();

    const result = receiver.verify({ rawBody, headers: signedHeaders(PREVIOUS_SECRET, rawBody), now: NOW });

    expect(result.ok).toBe(true);
  });

  it("rejects an event signed with any other secret", () => {
    const rawBody = receivedEvent();
    const stranger = `whsec_${Buffer.from("somebody-else-entirely-000000").toString("base64")}`;

    const result = receiver.verify({ rawBody, headers: signedHeaders(stranger, rawBody), now: NOW });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects the previous secret once rotation is over", () => {
    const rotated = new LocalInboundEmailReceiver({
      spoolDir,
      signingSecrets: { current: CURRENT_SECRET, previous: null },
    });
    const rawBody = receivedEvent();

    const result = rotated.verify({ rawBody, headers: signedHeaders(PREVIOUS_SECRET, rawBody), now: NOW });

    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports a missing signature", () => {
    const rawBody = receivedEvent();

    const result = receiver.verify({ rawBody, headers: {}, now: NOW });

    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("reads a spooled message and normalizes it", async () => {
    const raw = await readFile(join(FIXTURES, "mime/first-contact.eml"));
    await writeFile(join(spoolDir, "local-0001.eml"), raw);

    const message = await receiver.fetchMessage("local-0001");

    expect(message.raw.equals(raw)).toBe(true);
    expect(message.rfcMessageId).toBe("<msg-0001@example.test>");
    expect(message.from).toEqual({ address: "alice@example.test", displayName: "Alice Carter" });
    expect(message.deliveredTo).toContain("QZ2K7XN4VTM3RLHJWPC6YGBSFD@in.relay.test");
    expect(message.authentication).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
    expect(message.spamVerdict).toBe("unknown");
  });

  it("treats a missing spool file as a non-retryable fetch error", async () => {
    const failure = await receiver.fetchMessage("never-spooled").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InboundFetchError);
    expect(failure).toMatchObject({ retryable: false, code: "message_not_found" });
  });

  it("refuses an id that would leave the spool directory", async () => {
    const failure = await receiver.fetchMessage("../outside").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InboundFetchError);
    expect(failure).toMatchObject({ retryable: false, code: "invalid_message_id" });
  });
});

describe("local email domain provisioner", () => {
  let spoolDir: string;
  let provisioner: LocalEmailDomainProvisioner;

  beforeEach(async () => {
    spoolDir = await mkdtemp(join(tmpdir(), "email-spool-"));
    provisioner = new LocalEmailDomainProvisioner({ spoolDir });
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it("registers a domain with fixed records, all pending", async () => {
    const registration = await provisioner.registerSendingDomain("Customer.Test");

    expect(provisioner.provider).toBe("local");
    expect(registration).toMatchObject({ ok: true, region: null });
    if (!registration.ok) throw new Error("expected registration");
    expect(registration.readiness.sending).toBe("pending");
    expect(registration.readiness.receiving).toBe("not_requested");
    expect(registration.readiness.records.map((record) => [record.purpose, record.status])).toEqual([
      ["dkim", "pending"],
      ["spf", "pending"],
      ["return_path", "pending"],
      ["dmarc", "advisory"],
    ]);
    expect(registration.readiness.records.every((record) => record.name.endsWith("customer.test"))).toBe(true);
  });

  it("refuses a name that is not a domain", async () => {
    await expect(provisioner.registerSendingDomain("not a domain")).resolves.toEqual({
      ok: false,
      refused: "invalid_domain",
    });
    await expect(provisioner.registerSendingDomain("../etc")).resolves.toEqual({
      ok: false,
      refused: "invalid_domain",
    });
  });

  it("flips the domain to verified when the dev tool marks it", async () => {
    const registration = await provisioner.registerSendingDomain("customer.test");
    if (!registration.ok) throw new Error("expected registration");
    const target = { providerDomainId: registration.providerDomainId, domain: "customer.test" };

    expect((await provisioner.readiness(target)).sending).toBe("pending");

    await provisioner.markVerified("customer.test");
    const readiness = await provisioner.readiness(target);

    expect(readiness.sending).toBe("verified");
    expect(readiness.records.filter((record) => record.purpose !== "dmarc").map((record) => record.status)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
  });

  it("adds a pending receiving MX when receiving is enabled, verified by the same flip", async () => {
    const registration = await provisioner.registerSendingDomain("customer.test");
    if (!registration.ok) throw new Error("expected registration");

    const enabled = await provisioner.enableReceiving(registration.providerDomainId);
    expect(enabled.receiving).toBe("pending");
    expect(enabled.records.find((record) => record.purpose === "receiving_mx")).toMatchObject({
      type: "MX",
      name: "customer.test",
      status: "pending",
    });

    await provisioner.markVerified("customer.test");
    const readiness = await provisioner.readiness({
      providerDomainId: registration.providerDomainId,
      domain: "customer.test",
    });
    expect(readiness.receiving).toBe("verified");
  });

  it("forgets the verified state on removal", async () => {
    const registration = await provisioner.registerSendingDomain("customer.test");
    if (!registration.ok) throw new Error("expected registration");
    await provisioner.markVerified("customer.test");

    await provisioner.remove(registration.providerDomainId);
    await provisioner.requestVerification(registration.providerDomainId);
    const readiness = await provisioner.readiness({
      providerDomainId: registration.providerDomainId,
      domain: "customer.test",
    });

    expect(readiness.sending).toBe("pending");
  });
});

describe("local spool", () => {
  it("is .email-spool in the backend package, whatever the working directory", () => {
    expect(LOCAL_EMAIL_SPOOL_DIR).toBe(fileURLToPath(new URL("../../../.email-spool", import.meta.url)));
  });
});
