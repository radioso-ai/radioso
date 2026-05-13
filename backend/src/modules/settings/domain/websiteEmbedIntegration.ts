import { type WebsiteEmbedLauncherPosition } from "./websiteEmbedSettings.js";

export interface WebsiteEmbedIntegrationWorkspace {
  name: string;
  assistantName: string;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherPosition: WebsiteEmbedLauncherPosition;
}

export interface WebsiteEmbedIntegrationProvider {
  buildScriptUrl(): string | null;
  buildSnippet(workspace: WebsiteEmbedIntegrationWorkspace): string | null;
}

export class DefaultWebsiteEmbedIntegrationProvider implements WebsiteEmbedIntegrationProvider {
  constructor(_publicChatBaseUrl?: string) {}

  buildScriptUrl(): string | null {
    return null;
  }

  buildSnippet(workspace: WebsiteEmbedIntegrationWorkspace): string | null {
    if (!workspace.websiteEmbedEnabled || !workspace.websiteEmbedToken) {
      return null;
    }

    const scriptUrl = this.buildScriptUrl();
    if (!scriptUrl) {
      return null;
    }

    return [
      `<script`,
      `  async`,
      `  src="${escapeHtmlAttribute(scriptUrl)}"`,
      `  data-radioso-token="${escapeHtmlAttribute(workspace.websiteEmbedToken)}"`,
      `></script>`,
    ].join("\n");
  }
}

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
