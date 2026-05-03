import type { Router } from "express";

export interface ApplicationModuleRegistrationContext {
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
  registerDatabaseMigrator(migrator: ApplicationDatabaseMigrator): void;
  registerRouteMount(mount: ApplicationRouteMount): void;
  registerUsageLimitPolicy(policy: ApplicationUsageLimitPolicyRegistration): void;
}

export interface ApplicationModule {
  id: string;
  name?: string;
  register?(context: ApplicationModuleRegistrationContext): void;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface WebsiteEmbedIntegrationProvider {
  buildScriptUrl(): string | null;
  buildSnippet(workspace: WebsiteEmbedIntegrationWorkspace): string | null;
}

export interface UsageLimitReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface UsageLimitPolicy {
  reserveAnswer(input: {
    accountId?: string | null;
    workspaceId: string;
    surface: string;
  }): Promise<UsageLimitReservation>;
  reserveDocument(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<UsageLimitReservation>;
}

export interface ApplicationDatabasePort {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface ApplicationDatabaseMigrator {
  id: string;
  migrate(database: ApplicationDatabasePort): Promise<void>;
}

export interface ApplicationRouteMount {
  path: string;
  createRouter(dependencies: {
    connectorDb: UsageLimitDatabasePort;
  }): Router;
}

export interface UsageLimitDatabaseClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[] | { rows: T[] }>;
}

export interface UsageLimitDatabasePort extends UsageLimitDatabaseClient {
  withTransaction?<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T>;
}

export type ApplicationUsageLimitPolicyRegistration =
  | UsageLimitPolicy
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
        error(entry: unknown, message?: string): void;
      };
    }) => UsageLimitPolicy);

export interface WebsiteEmbedIntegrationWorkspace {
  name: string;
  assistantName: string;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherIcon: string;
  websiteEmbedLauncherPosition: string;
}
