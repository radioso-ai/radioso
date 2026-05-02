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

  const modules = candidates.flatMap((candidate) => {
    if (!candidate) {
      return [];
    }
    return Array.isArray(candidate) ? candidate : [candidate];
  });

  return modules.filter((module, index) =>
    modules.findIndex((candidate) => candidate.id === module.id) === index
  );
};

const appendUniqueModules = (
  modules: ApplicationModule[],
  nextModules: ApplicationModule[],
  seenModuleIds: Set<string>,
) => {
  for (const module of nextModules) {
    if (seenModuleIds.has(module.id)) {
      continue;
    }

    seenModuleIds.add(module.id);
    modules.push(module);
  }
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
  const seenModuleIds = new Set<string>();
  for (const specifier of specifiers) {
    const loaded = await import(specifier) as ApplicationModuleExport;
    const resolvedModules = asApplicationModules(loaded);
    appendUniqueModules(modules, resolvedModules, seenModuleIds);
    logger.info(
      {
        moduleSpecifier: specifier,
        moduleIds: resolvedModules.map((module) => module.id),
      },
      "Loaded Radioso application module",
    );
  }

  return modules;
};
