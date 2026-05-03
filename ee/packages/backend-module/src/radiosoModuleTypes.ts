export interface ApplicationModuleRegistrationContext {
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
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
