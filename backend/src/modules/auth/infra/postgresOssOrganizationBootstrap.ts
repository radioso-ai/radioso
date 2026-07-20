import type { Kysely, Transaction } from "kysely";

import type {
  OrganizationCoreProvisioner,
  OrganizationCoreProvisioningRequest,
  OrganizationCoreProvisioningResult,
} from "../../../shared/domain/organizationCreationGuard.js";
import type { Database } from "../../../shared/infra/database.js";
import type { DB } from "../../../shared/infra/kysely/schema.js";
import {
  sessionAdvisoryLock,
  sessionAdvisoryUnlock,
  trySessionAdvisoryLock,
} from "../../../shared/infra/kysely/sqlHelpers.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { OssOrganizationBootstrapPort } from "../services/ossOrganizationCreationGuard.js";
import { registrationClosed } from "../services/ossOrganizationCreationGuard.js";
import {
  PostgresOrganizationProvisioner,
  type OrganizationCoreTransactionRunner,
} from "./postgresOrganizationProvisioner.js";

const LOCK_KEY = "radioso:oss:organization-bootstrap";

export class PostgresOssOrganizationBootstrap implements OssOrganizationBootstrapPort {
  private readonly provisioner: OrganizationCoreProvisioner;

  constructor(
    private readonly database: Pick<Database, "kysely">,
    auditService: AuditService,
  ) {
    this.provisioner = new PostgresOrganizationProvisioner(
      database,
      auditService,
      new OssBootstrapTransactionRunner(database.kysely),
    );
  }

  async provision(input: OrganizationCoreProvisioningRequest): Promise<OrganizationCoreProvisioningResult> {
    return this.provisioner.provision(input);
  }

  async isAvailable(): Promise<boolean> {
    return this.database.kysely.connection().execute(async (connection) => {
      const result = await trySessionAdvisoryLock(LOCK_KEY).execute(connection);
      if (!(result.rows[0]?.acquired ?? false)) return false;
      try {
        return !(await hasOrganizations(connection));
      } finally {
        await sessionAdvisoryUnlock(LOCK_KEY).execute(connection);
      }
    });
  }
}

class OssBootstrapTransactionRunner implements OrganizationCoreTransactionRunner {
  constructor(private readonly database: Kysely<DB>) {}

  async run<T>(work: (transaction: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.database.connection().execute(async (connection) => {
      await sessionAdvisoryLock(LOCK_KEY).execute(connection);
      try {
        return await connection.transaction().execute(async (transaction) => {
          if (await hasOrganizations(transaction)) {
            throw registrationClosed();
          }
          return work(transaction);
        });
      } finally {
        await sessionAdvisoryUnlock(LOCK_KEY).execute(connection);
      }
    });
  }
}

const hasOrganizations = async (database: Kysely<DB> | Transaction<DB>): Promise<boolean> => {
  const row = await database.selectFrom("accounts").select("id").limit(1).executeTakeFirst();
  return Boolean(row);
};
