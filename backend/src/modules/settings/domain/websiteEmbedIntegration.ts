import {
  type WebsiteEmbedLauncherIcon,
  type WebsiteEmbedLauncherPosition,
} from "./websiteEmbedSettings.js";
import { resolveAssistantDisplayName } from "./assistantBootstrapSettings.js";

export interface WebsiteEmbedIntegrationWorkspace {
  name: string;
  assistantName: string;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherIcon: WebsiteEmbedLauncherIcon;
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

    const originAttribute =
      workspace.websiteEmbedAllowedOrigins.length > 0
        ? ` data-radioso-allowed-origins="${escapeHtmlAttribute(workspace.websiteEmbedAllowedOrigins.join(","))}"`
        : "";
    const displayName = resolveAssistantDisplayName({
      assistantName: workspace.assistantName,
      workspaceName: workspace.name,
    });
    const titleOverride = displayName
      ? ` data-radioso-copy="${escapeHtmlAttribute(JSON.stringify({ embeddedChatTitle: displayName }))}"`
      : "";

    return [
      `<script`,
      `  async`,
      `  src="${escapeHtmlAttribute(scriptUrl)}"`,
      `  data-radioso-token="${escapeHtmlAttribute(workspace.websiteEmbedToken)}"`,
      `  data-radioso-launcher-label="${escapeHtmlAttribute(workspace.websiteEmbedLauncherLabel)}"`,
      `  data-radioso-launcher-icon="${escapeHtmlAttribute(workspace.websiteEmbedLauncherIcon)}"`,
      `  data-radioso-launcher-position="${escapeHtmlAttribute(workspace.websiteEmbedLauncherPosition)}"${originAttribute}${titleOverride}`,
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
