import type { Env } from "../app/config/env.js";
import type { ApplicationModule } from "../app/composition/index.js";
import type { AppLogger } from "../shared/observability/logger.js";

type ApplicationModuleExport =
  | ApplicationModule
  | ApplicationModule[]
  | {
      default?: ApplicationModule | ApplicationModule[];
      applicationModule?: ApplicationModule;
      applicationModules?: ApplicationModule[];
    };

const asApplicationModules = (moduleExport: ApplicationModuleExport): ApplicationModule[] => {
  if (Array.isArray(moduleExport)) {
    return moduleExport;
  }

  if ("id" in moduleExport && typeof moduleExport.id === "string") {
    return [moduleExport];
  }

  const exportContainer = moduleExport as {
    default?: ApplicationModule | ApplicationModule[];
    applicationModule?: ApplicationModule;
    applicationModules?: ApplicationModule[];
  };
  const candidates = [
    exportContainer.applicationModules,
    exportContainer.applicationModule,
    exportContainer.default,
  ];

  return candidates.flatMap((candidate) => {
    if (!candidate) {
      return [];
    }
    return Array.isArray(candidate) ? candidate : [candidate];
  });
};

export const loadConfiguredApplicationModules = async (
  env: Pick<Env, "RADIOSO_APPLICATION_MODULES">,
  logger: Pick<AppLogger, "info">,
): Promise<ApplicationModule[]> => {
  const specifiers = env.RADIOSO_APPLICATION_MODULES
    ?.split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean) ?? [];

  const modules: ApplicationModule[] = [];
  for (const specifier of specifiers) {
    const loaded = await import(specifier) as ApplicationModuleExport;
    const resolvedModules = asApplicationModules(loaded);
    logger.info(
      {
        moduleSpecifier: specifier,
        moduleIds: resolvedModules.map((module) => module.id),
      },
      "Loaded Radioso application module",
    );
    modules.push(...resolvedModules);
  }

  return modules;
};
