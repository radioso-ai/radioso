import type { ApplicationModule } from "../../app/composition/applicationModule.js";
import { PostgresOssOrganizationBootstrap } from "./infra/postgresOssOrganizationBootstrap.js";
import { OssOrganizationCreationGuard } from "./services/ossOrganizationCreationGuard.js";

export { OssOrganizationCreationGuard } from "./services/ossOrganizationCreationGuard.js";

export const createOssOrganizationCreationApplicationModule = (): ApplicationModule => ({
  id: "radioso-oss-organization-creation",
  name: "OSS organization creation",
  register(context) {
    context.registerOrganizationCreationGuard(({ auditService, database }) => (
      new OssOrganizationCreationGuard(new PostgresOssOrganizationBootstrap(database, auditService))
    ));
  },
});
