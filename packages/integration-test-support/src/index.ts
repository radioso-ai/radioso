export const INTEGRATION_DATABASE_MARKER = "radioso:disposable-integration-database:v1";

export interface IntegrationDatabaseIdentity {
  databaseName: string;
  databaseOid: string;
  clusterIdentifier: string;
  marker: string | null;
}

export interface SafeIntegrationDatabaseUrlInput {
  integrationDatabaseUrl: string;
  applicationDatabaseUrl?: string;
  acknowledgedDatabaseName?: string;
  requireAcknowledgedDatabaseName?: boolean;
}

export interface AssertMarkedIntegrationDatabaseInput extends SafeIntegrationDatabaseUrlInput {
  readIdentity: (databaseUrl: string) => Promise<IntegrationDatabaseIdentity>;
}

export interface ParsedDatabaseTarget {
  databaseName: string;
  display: string;
  identity: string;
}

const normalizeHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return ["localhost", "127.0.0.1", "::1"].includes(normalized) ? "loopback" : normalized || "local-socket";
};

const parseDatabaseTarget = (databaseUrl: string, variableName: string): ParsedDatabaseTarget => {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL; refusing to run integration tests`);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use the postgres or postgresql protocol; refusing to run integration tests`);
  }

  const targetOverrideParameters = new Set(["database", "dbname", "host", "hostaddr", "port", "service", "servicefile"]);
  const targetOverride = [...parsed.searchParams.keys()]
    .find((parameter) => targetOverrideParameters.has(parameter.toLowerCase()));
  if (targetOverride) {
    throw new Error(
      `${variableName} contains target override parameter ${targetOverride}; put the host, port, and database in the URL authority and path`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || databaseName.includes("/")) {
    throw new Error(`${variableName} must name exactly one PostgreSQL database; refusing to run integration tests`);
  }

  const host = normalizeHost(parsed.hostname);
  const port = parsed.port || "5432";
  return {
    databaseName,
    display: `${host}:${port}/${databaseName}`,
    identity: `${host}:${port}/${databaseName}`,
  };
};

export const assertIntegrationDatabaseUrlIsSafe = ({
  integrationDatabaseUrl,
  applicationDatabaseUrl,
  acknowledgedDatabaseName,
  requireAcknowledgedDatabaseName = false,
}: SafeIntegrationDatabaseUrlInput): ParsedDatabaseTarget => {
  const integrationTarget = parseDatabaseTarget(integrationDatabaseUrl, "INTEGRATION_DATABASE_URL");

  if (!integrationTarget.databaseName.endsWith("_test")) {
    throw new Error(
      `Integration database ${integrationTarget.display} must end in _test; refusing to run destructive integration tests`,
    );
  }

  if (applicationDatabaseUrl) {
    const applicationTarget = parseDatabaseTarget(applicationDatabaseUrl, "DATABASE_URL");
    if (applicationTarget.identity === integrationTarget.identity) {
      throw new Error(
        `INTEGRATION_DATABASE_URL and DATABASE_URL resolve to the same PostgreSQL database (${integrationTarget.display}); refusing to run destructive integration tests`,
      );
    }
  }

  if (
    (requireAcknowledgedDatabaseName || acknowledgedDatabaseName !== undefined)
    && acknowledgedDatabaseName !== integrationTarget.databaseName
  ) {
    throw new Error(
      `Set RADIOSO_INTEGRATION_DATABASE_NAME=${integrationTarget.databaseName} to acknowledge the exact disposable database before preparing it`,
    );
  }

  return integrationTarget;
};

const identifiesSameDatabase = (
  first: IntegrationDatabaseIdentity,
  second: IntegrationDatabaseIdentity,
): boolean => first.clusterIdentifier === second.clusterIdentifier && first.databaseOid === second.databaseOid;

export const assertIntegrationDatabaseIdentityIsSafe = async ({
  integrationDatabaseUrl,
  applicationDatabaseUrl,
  readIdentity,
}: AssertMarkedIntegrationDatabaseInput): Promise<IntegrationDatabaseIdentity> => {
  const target = assertIntegrationDatabaseUrlIsSafe({ integrationDatabaseUrl, applicationDatabaseUrl });

  let integrationIdentity: IntegrationDatabaseIdentity;
  try {
    integrationIdentity = await readIdentity(integrationDatabaseUrl);
  } catch {
    throw new Error(
      `Unable to verify integration database ${target.display}; refusing to run destructive integration tests`,
    );
  }

  if (integrationIdentity.databaseName !== target.databaseName) {
    throw new Error(
      `PostgreSQL reported database ${integrationIdentity.databaseName}, but the integration URL names ${target.databaseName}; refusing to run destructive integration tests`,
    );
  }

  if (applicationDatabaseUrl) {
    const applicationTarget = parseDatabaseTarget(applicationDatabaseUrl, "DATABASE_URL");
    let applicationIdentity: IntegrationDatabaseIdentity;
    try {
      applicationIdentity = await readIdentity(applicationDatabaseUrl);
    } catch {
      throw new Error("Unable to verify application database; refusing to run destructive integration tests");
    }

    if (applicationIdentity.databaseName !== applicationTarget.databaseName) {
      throw new Error(
        `PostgreSQL reported database ${applicationIdentity.databaseName}, but the application URL names ${applicationTarget.databaseName}; refusing to run destructive integration tests`,
      );
    }

    if (identifiesSameDatabase(integrationIdentity, applicationIdentity)) {
      throw new Error(
        `INTEGRATION_DATABASE_URL and DATABASE_URL resolve to the same PostgreSQL database (${target.display}); refusing to run destructive integration tests`,
      );
    }
  }

  return integrationIdentity;
};

export const assertMarkedIntegrationDatabase = async ({
  integrationDatabaseUrl,
  applicationDatabaseUrl,
  readIdentity,
}: AssertMarkedIntegrationDatabaseInput): Promise<IntegrationDatabaseIdentity> => {
  const target = assertIntegrationDatabaseUrlIsSafe({ integrationDatabaseUrl, applicationDatabaseUrl });
  const integrationIdentity = await assertIntegrationDatabaseIdentityIsSafe({
    integrationDatabaseUrl,
    applicationDatabaseUrl,
    readIdentity,
  });

  if (integrationIdentity.marker !== INTEGRATION_DATABASE_MARKER) {
    throw new Error(
      `Integration database ${target.display} is not marked as disposable; run pnpm run test:integration:prepare with the exact database-name acknowledgement first`,
    );
  }

  return integrationIdentity;
};

export const shouldGuardIntegrationTests = (argv: readonly string[]): boolean => {
  const argumentsText = argv.join(" ").replaceAll("\\", "/");
  if (/tests\/integration(?:\/|\b)/.test(argumentsText)) {
    return true;
  }
  if (/\.integration\.test\.[cm]?[jt]sx?\b/.test(argumentsText)) {
    return true;
  }
  if (/tests\/(?:unit|contract)(?:\/|\b)/.test(argumentsText)) {
    return false;
  }
  return !argv.some((argument) => /\.(?:test|spec)\.[cm]?[jt]sx?\b/.test(argument));
};

export const requireIntegrationDatabaseUrl = (databaseUrl: string | undefined): string => {
  if (!databaseUrl) {
    throw new Error(
      "INTEGRATION_DATABASE_URL is required for integration tests; refusing to report skipped database coverage as success",
    );
  }
  return databaseUrl;
};
