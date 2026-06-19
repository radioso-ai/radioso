export const slackBotScopes = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
] as const;

export const requiredSlackEnvVars = [
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
] as const;

export interface SlackAppManifest {
  display_information: {
    name: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
  };
  oauth_config: {
    redirect_urls: string[];
    scopes: {
      bot: string[];
    };
  };
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
    };
    interactivity: {
      is_enabled: boolean;
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

const normalizeBaseUrl = (appBaseUrl: string): string => appBaseUrl.replace(/\/+$/u, "");

export const buildSlackManifest = (appBaseUrl: string): SlackAppManifest => {
  const baseUrl = normalizeBaseUrl(appBaseUrl);
  return {
    display_information: {
      name: "Radioso",
    },
    features: {
      bot_user: {
        display_name: "Radioso",
        always_online: false,
      },
    },
    oauth_config: {
      redirect_urls: [`${baseUrl}/api/v1/oauth/callback/slack`],
      scopes: {
        bot: [...slackBotScopes],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: `${baseUrl}/api/connectors/slack/events`,
        bot_events: ["app_mention", "message.im"],
      },
      interactivity: {
        is_enabled: false,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
};
