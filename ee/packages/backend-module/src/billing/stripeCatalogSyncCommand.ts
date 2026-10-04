/**
 * The `stripe:sync` operator command: reads what a Stripe account holds through the
 * {@link StripeCatalogAdmin} port, plans the difference from the plan catalog, prints it, and with
 * `--apply` executes it. Owns flags, the live-mode guard, operator-facing output, and where a new
 * webhook signing secret goes; the planner owns what should change, the adapter owns Stripe calls.
 */
import { constants as fsConstants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { formatPrice, PLAN_CATALOG, STRIPE_PLAN_METADATA_KEY } from "@radioso/plan-catalog";

import type { StripeCatalogAdmin, StripeCreatedWebhookEndpoint, StripeProductPatch } from "./stripeCatalogAdmin.js";
import {
  desiredStripeCatalog,
  planStripeCatalogSync,
  portalFeaturesFor,
  type DesiredPortalProduct,
  type DesiredStripeCatalog,
  type DesiredStripePrice,
  type StripeCatalogState,
  type StripeCatalogSyncAction,
  type StripeCatalogSyncNotice,
  type StripeCatalogSyncPlan,
} from "./stripeCatalogSync.js";

interface StripeCatalogSyncCommandDeps {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /** The directory a relative `--webhook-secret-file` resolves against: where the operator ran the command from. */
  cwd: string;
  createAdmin: (secretKey: string) => StripeCatalogAdmin;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface CommandOptions {
  apply: boolean;
  live: boolean;
  webhookUrl: string | null;
  webhookSecretFile: string | null;
}

type StripeKeyMode = "test" | "live";

/** A failure the operator fixes by changing the invocation; printed as-is with exit code 1. */
class CommandError extends Error {}

const USAGE = [
  "Usage: stripe:sync [--apply [--live]] [--webhook-url <url> [--webhook-secret-file <path>]]",
  "",
  "Makes the Stripe account behind STRIPE_SECRET_KEY match the Radioso plan catalog: products,",
  "lookup-keyed prices, tax defaults, the customer portal, and (with --webhook-url) the billing",
  "webhook endpoint. Prints the plan and changes nothing unless --apply is given.",
  "",
  "  --apply                       Make the planned changes.",
  "  --live                        Required with --apply when the key is a live-mode key.",
  "  --webhook-url <url>           Create or update the webhook endpoint at this URL.",
  "  --webhook-secret-file <path>  Write a newly created endpoint's signing secret here (mode 0600).",
].join("\n");

export const runStripeCatalogSyncCommand = async (deps: StripeCatalogSyncCommandDeps): Promise<number> => {
  const secretKey = deps.env.STRIPE_SECRET_KEY?.trim() ?? "";
  // Stripe masks keys in its own errors; this is the backstop for anything that echoes one verbatim.
  const redact = (text: string): string => (secretKey ? text.split(secretKey).join("[redacted]") : text);
  const io = { out: (line: string) => deps.out(redact(line)), err: (line: string) => deps.err(redact(line)) };
  try {
    return await runCommand(deps, secretKey, io);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof CommandError) {
      io.err("Run with --help for usage.");
    }
    return 1;
  }
};

const runCommand = async (
  deps: StripeCatalogSyncCommandDeps,
  secretKey: string,
  io: Pick<StripeCatalogSyncCommandDeps, "out" | "err">,
): Promise<number> => {
  if (deps.argv.includes("--help") || deps.argv.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const options = resolveWebhookSecretFile(parseOptions(deps.argv), deps.cwd);
  const mode = stripeKeyMode(secretKey);
  if (!mode) {
    throw new CommandError("Set STRIPE_SECRET_KEY to a Stripe secret (sk_) or restricted (rk_) key.");
  }
  if (options.live && mode === "test") {
    throw new CommandError(
      "--live was given but STRIPE_SECRET_KEY is a TEST key. Remove --live, or set STRIPE_SECRET_KEY to your live-mode key.",
    );
  }
  if (mode === "live" && options.apply && !options.live) {
    throw new CommandError(
      "Refusing to change a LIVE Stripe account without --live. Review the dry run, then re-run with --apply --live.",
    );
  }

  const admin = deps.createAdmin(secretKey);
  io.out(`Stripe ${mode.toUpperCase()} mode`);
  io.out(`Account: ${await describeAccount(admin)}`);

  const metadataKey = deps.env.STRIPE_PLAN_METADATA_KEY?.trim() || STRIPE_PLAN_METADATA_KEY;
  const desired = desiredStripeCatalog(PLAN_CATALOG, {
    metadataKey,
    webhook: options.webhookUrl ? { url: options.webhookUrl, apiVersion: admin.apiVersion } : undefined,
  });
  const current = await readStripeCatalogState(admin, desired);
  const plan = planStripeCatalogSync(desired, current);

  printPlan(io, desired, current, plan);

  if (plan.actions.length === 0) {
    io.out("Stripe already matches the catalog. Nothing to change.");
    return 0;
  }
  if (!options.apply) {
    io.out(`Dry run: nothing changed. Re-run with --apply${mode === "live" ? " --live" : ""} to make these changes.`);
    return 0;
  }
  await assertSecretFileCanBeWritten(plan, options);
  await applyPlan(admin, plan, current, options, io);
  io.out(`Applied ${plan.actions.length} change${plan.actions.length === 1 ? "" : "s"}.`);
  return 0;
};

const parseOptions = (argv: readonly string[]): CommandOptions => {
  // `pnpm run stripe:sync -- --apply` forwards the separator; everything after it is still a flag here.
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let values: { apply?: boolean; live?: boolean; "webhook-url"?: string; "webhook-secret-file"?: string };
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        apply: { type: "boolean" },
        live: { type: "boolean" },
        "webhook-url": { type: "string" },
        "webhook-secret-file": { type: "string" },
      },
    }));
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }

  const webhookUrl = values["webhook-url"]?.trim() || null;
  const webhookSecretFile = values["webhook-secret-file"]?.trim() || null;
  if (webhookSecretFile && !webhookUrl) {
    throw new CommandError("--webhook-secret-file needs --webhook-url: the secret belongs to the endpoint that run creates.");
  }
  if (webhookUrl && !isHttpsUrl(webhookUrl)) {
    throw new CommandError(`--webhook-url must be an absolute https:// URL, got "${webhookUrl}".`);
  }
  return { apply: values.apply ?? false, live: values.live ?? false, webhookUrl, webhookSecretFile };
};

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** `--webhook-secret-file` is relative to where the operator ran the command, not this package's directory. */
const resolveWebhookSecretFile = (options: CommandOptions, cwd: string): CommandOptions =>
  options.webhookSecretFile ? { ...options, webhookSecretFile: resolve(cwd, options.webhookSecretFile) } : options;

const stripeKeyMode = (key: string): StripeKeyMode | null => {
  const mode = /^(?:sk|rk)_(test|live)_/.exec(key)?.[1];
  return mode === "test" || mode === "live" ? mode : null;
};

const describeAccount = async (admin: StripeCatalogAdmin): Promise<string> => {
  try {
    const account = await admin.retrieveAccount();
    return account.name ? `${account.id} (${account.name})` : account.id;
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message : String(error)})`;
  }
};

const readStripeCatalogState = async (
  admin: StripeCatalogAdmin,
  desired: DesiredStripeCatalog,
): Promise<StripeCatalogState> => {
  const [products, prices, portal, webhookEndpoints, tax, activeTaxRegistrations] = await Promise.all([
    Promise.all(desired.products.map((product) => admin.retrieveProduct(product.id))),
    Promise.all(desired.prices.map((price) => admin.findPriceByLookupKey(price.lookupKey))),
    admin.findPortalConfiguration(),
    desired.webhook ? admin.listWebhookEndpoints() : Promise.resolve([]),
    admin.retrieveTaxSettings(),
    admin.countActiveTaxRegistrations(),
  ]);
  return {
    products: new Map(products.flatMap((product) => (product ? [[product.id, product] as const] : []))),
    prices: new Map(prices.flatMap((price) => (price ? [[price.lookupKey, price] as const] : []))),
    portal,
    webhookEndpoints,
    tax,
    activeTaxRegistrations,
  };
};

const printPlan = (
  io: Pick<StripeCatalogSyncCommandDeps, "out">,
  desired: DesiredStripeCatalog,
  current: StripeCatalogState,
  plan: StripeCatalogSyncPlan,
): void => {
  io.out(
    `Catalog: ${desired.products.length} products, ${desired.prices.length} prices, ` +
      `prices ${desired.tax.taxBehavior === "exclusive" ? "exclude" : "include"} tax (tax behavior ${desired.tax.taxBehavior})`,
  );
  io.out(
    `Stripe Tax: status ${current.tax.status}, ${current.activeTaxRegistrations} active registration` +
      `${current.activeTaxRegistrations === 1 ? "" : "s"}`,
  );
  if (plan.actions.length > 0) {
    io.out("");
    io.out(`Planned changes (${plan.actions.length}):`);
    plan.actions.forEach((action, index) => io.out(`  ${index + 1}. ${describeAction(action)}`));
  }
  if (plan.notices.length > 0) {
    io.out("");
    for (const notice of plan.notices) {
      io.out(`${isSoftNotice(notice) ? "Note" : "Warning"}: ${describeNotice(notice)}`);
    }
  }
  io.out("");
};

const describePrice = (price: DesiredStripePrice): string =>
  `${price.lookupKey}: ${formatPrice(price.unitAmount, price.currency.toUpperCase())} ` +
  `${price.recurringInterval ? `per ${price.recurringInterval}` : "one-time"}, tax ${price.taxBehavior}, on ${price.productId}`;

const describePortalProducts = (products: readonly DesiredPortalProduct[]): string =>
  products.map((product) => `${product.productId} (${product.lookupKeys.join(", ")})`).join(", ");

const describeProductPatch = (patch: StripeProductPatch): string => {
  const changes: string[] = [];
  if (patch.name !== undefined) {
    changes.push(`name "${patch.name}"`);
  }
  if (patch.active) {
    changes.push("unarchive");
  }
  if (patch.taxCode !== undefined) {
    changes.push(`tax code ${patch.taxCode}`);
  }
  for (const [key, value] of Object.entries(patch.metadata ?? {})) {
    changes.push(value === "" ? `remove metadata ${key}` : `metadata ${key}=${value}`);
  }
  return changes.join(", ");
};

const describeAction = (action: StripeCatalogSyncAction): string => {
  switch (action.kind) {
    case "create_product": {
      const metadata = Object.entries(action.product.metadata).map(([key, value]) => `${key}=${value}`);
      return (
        `create product ${action.product.id} "${action.product.name}", tax code ${action.product.taxCode}, ` +
        (metadata.length > 0 ? `metadata ${metadata.join(", ")}` : "no plan metadata")
      );
    }
    case "update_product":
      return `update product ${action.productId}: ${describeProductPatch(action.patch)}`;
    case "create_price":
      return action.replaces
        ? `create price ${describePrice(action.price)}; takes the lookup key from ${action.replaces.priceId} ` +
            `on ${action.replaces.productId}, which stays active for its subscribers`
        : `create price ${describePrice(action.price)}`;
    case "update_tax_defaults":
      return `set tax defaults: tax behavior ${action.taxBehavior}, tax code ${action.taxCode}`;
    case "create_portal_configuration":
      return `create customer portal configuration offering ${describePortalProducts(action.products)}`;
    case "update_portal_configuration":
      return `update customer portal configuration ${action.configurationId} to offer ${describePortalProducts(action.products)}`;
    case "create_webhook_endpoint":
      return `create webhook endpoint ${action.url} for ${action.enabledEvents.join(", ")} (API version ${action.apiVersion})`;
    case "update_webhook_endpoint":
      return action.addedEvents.length > 0
        ? `update webhook endpoint ${action.endpointId} (${action.url}): add ${action.addedEvents.join(", ")}, keeping its other events`
        : `update webhook endpoint ${action.endpointId} (${action.url}): re-enable it`;
  }
};

/** Notices that describe a benign or unconfirmed state, printed under "Note" rather than "Warning". */
const isSoftNotice = (notice: StripeCatalogSyncNotice): boolean =>
  notice.kind === "webhook_secret_unreadable" || notice.kind === "webhook_api_version_account_default";

const describeNotice = (notice: StripeCatalogSyncNotice): string => {
  switch (notice.kind) {
    case "webhook_secret_unreadable":
      return (
        `webhook endpoint ${notice.endpointId} already exists for ${notice.url}. Stripe returns a signing secret only ` +
        "when it creates an endpoint, so STRIPE_WEBHOOK_SECRET must already hold it; roll the secret in the Dashboard " +
        "if it is lost."
      );
    case "webhook_api_version_mismatch":
      return (
        `webhook endpoint ${notice.endpointId} sends events in API version ${notice.currentApiVersion}, ` +
        `and the billing runtime reads ${notice.expectedApiVersion} payloads. Stripe cannot change an endpoint's version: ` +
        "delete the endpoint in the Dashboard, re-run with --webhook-url to recreate it, and store the new signing secret."
      );
    case "webhook_api_version_account_default":
      return (
        `webhook endpoint ${notice.endpointId} uses the account's default API version, and the billing runtime expects ` +
        `${notice.expectedApiVersion} or newer. Check the account default in Dashboard > Developers > Webhooks; if it's ` +
        "older, re-run with --webhook-url to create a new endpoint pinned to the version this run expects."
      );
    case "portal_not_default":
      return (
        `customer portal configuration ${notice.configurationId} is not the default, and portal sessions use the ` +
        "default. Open Dashboard > Settings > Billing > Customer portal, click Save once to create the default, then " +
        "re-run this sync so the default carries these settings."
      );
    case "tax_not_active":
      return (
        `Stripe Tax is ${notice.status}` +
        (notice.missingFields.length > 0 ? ` (missing: ${notice.missingFields.join(", ")})` : "") +
        ". Checkout sends automatic_tax, so it fails until you set the head office address in Dashboard > Tax."
      );
    case "tax_no_active_registrations":
      return (
        "Stripe Tax has no active registrations, so Checkout collects no tax anywhere. Add a registration for " +
        "each place you collect VAT in Dashboard > Tax > Registrations."
      );
  }
};

/** Checked before any change: a secret Stripe shows once must have somewhere to land. */
const assertSecretFileCanBeWritten = async (plan: StripeCatalogSyncPlan, options: CommandOptions): Promise<void> => {
  const createsEndpoint = plan.actions.some((action) => action.kind === "create_webhook_endpoint");
  if (!createsEndpoint || !options.webhookSecretFile) {
    return;
  }
  const exists = await access(options.webhookSecretFile).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new CommandError(
      `Refusing to overwrite ${options.webhookSecretFile}. Pass a path that does not exist yet; nothing was changed.`,
    );
  }
  const secretFileDir = dirname(options.webhookSecretFile);
  const writable = await access(secretFileDir, fsConstants.W_OK).then(
    () => true,
    () => false,
  );
  if (!writable) {
    throw new CommandError(
      `Cannot write to ${secretFileDir} for --webhook-secret-file ${options.webhookSecretFile}. Pass a path in a ` +
        "directory that exists and is writable; nothing was changed.",
    );
  }
};

const applyPlan = async (
  admin: StripeCatalogAdmin,
  plan: StripeCatalogSyncPlan,
  current: StripeCatalogState,
  options: CommandOptions,
  io: Pick<StripeCatalogSyncCommandDeps, "out">,
): Promise<void> => {
  // Portal products name prices by lookup key; prices created earlier in this run get new ids.
  const priceIds = new Map([...current.prices].map(([lookupKey, price]) => [lookupKey, price.id]));
  const portalFeatures = (products: readonly DesiredPortalProduct[]) => {
    const features = portalFeaturesFor(products, (lookupKey) => priceIds.get(lookupKey));
    if (!features) {
      throw new Error("A customer portal price has no Stripe price id yet; re-run the sync.");
    }
    return features;
  };

  for (const [index, action] of plan.actions.entries()) {
    switch (action.kind) {
      case "create_product":
        await admin.createProduct(action.product);
        break;
      case "update_product":
        await admin.updateProduct(action.productId, action.patch);
        break;
      case "create_price": {
        const created = await admin.createPrice({ ...action.price, transferLookupKey: action.transferLookupKey });
        priceIds.set(action.price.lookupKey, created.id);
        break;
      }
      case "update_tax_defaults":
        await admin.updateTaxDefaults({ taxBehavior: action.taxBehavior, taxCode: action.taxCode });
        break;
      case "create_portal_configuration": {
        const created = await admin.createPortalConfiguration(portalFeatures(action.products));
        if (!created.isDefault) {
          io.out(`Warning: ${describeNotice({ kind: "portal_not_default", configurationId: created.id })}`);
        }
        break;
      }
      case "update_portal_configuration":
        await admin.updatePortalConfiguration(action.configurationId, portalFeatures(action.products));
        break;
      case "create_webhook_endpoint": {
        const created = await admin.createWebhookEndpoint({
          url: action.url,
          enabledEvents: action.enabledEvents,
          apiVersion: action.apiVersion,
        });
        await storeWebhookSecret(created, options, io);
        break;
      }
      case "update_webhook_endpoint":
        await admin.updateWebhookEndpoint(action.endpointId, { enabledEvents: action.enabledEvents });
        break;
    }
    io.out(`  done ${index + 1}/${plan.actions.length}: ${describeAction(action)}`);
  }
};

const storeWebhookSecret = async (
  created: StripeCreatedWebhookEndpoint,
  options: CommandOptions,
  io: Pick<StripeCatalogSyncCommandDeps, "out">,
): Promise<void> => {
  if (!options.webhookSecretFile) {
    io.out(`Store this now: Stripe shows this signing secret only once. STRIPE_WEBHOOK_SECRET for ${created.id}:`);
    io.out(created.secret);
    return;
  }
  try {
    await writeFile(options.webhookSecretFile, created.secret, { mode: 0o600, flag: "wx" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The endpoint already exists in Stripe at this point; losing the secret here means rolling it
    // in the Dashboard, so print it now rather than letting it go only to the error path.
    io.out(`could not write ${options.webhookSecretFile}: ${reason}; store this secret now. STRIPE_WEBHOOK_SECRET for ${created.id}:`);
    io.out(created.secret);
    throw new Error(
      `Created webhook endpoint ${created.id} but could not write its signing secret to ${options.webhookSecretFile} ` +
        `(${reason}). The secret was printed above; store it now.`,
      { cause: error },
    );
  }
  io.out(`Signing secret for webhook endpoint ${created.id} written to ${options.webhookSecretFile} (mode 0600).`);
};
