import type {
  WebsiteEmbedIntegrationProvider,
  WebsiteEmbedIntegrationWorkspace,
} from "./radiosoModuleTypes.js";

export interface HostedWebsiteEmbedIntegrationOptions {
  widgetOrigin?: string;
  scriptPath?: string;
}

export class HostedWebsiteEmbedIntegrationProvider implements WebsiteEmbedIntegrationProvider {
  private readonly widgetOrigin?: string;
  private readonly scriptPath: string;

  constructor(options: HostedWebsiteEmbedIntegrationOptions) {
    this.widgetOrigin = options.widgetOrigin;
    this.scriptPath = options.scriptPath ?? "/radioso-embed.js";
  }

  buildScriptUrl(): string | null {
    if (!this.widgetOrigin) {
      return null;
    }

    try {
      return new URL(this.scriptPath, this.widgetOrigin).toString();
    } catch {
      return null;
    }
  }

  buildSnippet(workspace: WebsiteEmbedIntegrationWorkspace): string | null {
    if (!workspace.websiteEmbedEnabled || !workspace.websiteEmbedToken) {
      return null;
    }

    const scriptUrl = this.buildScriptUrl();
    if (!scriptUrl) {
      return null;
    }

    const title = workspace.assistantName.trim() || workspace.name.trim();
    const copy = title ? { embeddedChatTitle: title } : null;
    const originAttribute =
      workspace.websiteEmbedAllowedOrigins.length > 0
        ? ` data-radioso-allowed-origins="${escapeHtmlAttribute(workspace.websiteEmbedAllowedOrigins.join(","))}"`
        : "";
    const copyAttribute = copy
      ? ` data-radioso-copy="${escapeHtmlAttribute(JSON.stringify(copy))}"`
      : "";

    return [
      `<script`,
      `  async`,
      `  src="${escapeHtmlAttribute(scriptUrl)}"`,
      `  data-radioso-token="${escapeHtmlAttribute(workspace.websiteEmbedToken)}"`,
      `  data-radioso-launcher-label="${escapeHtmlAttribute(workspace.websiteEmbedLauncherLabel)}"`,
      `  data-radioso-launcher-icon="${escapeHtmlAttribute(workspace.websiteEmbedLauncherIcon)}"`,
      `  data-radioso-launcher-position="${escapeHtmlAttribute(workspace.websiteEmbedLauncherPosition)}"${originAttribute}${copyAttribute}`,
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
