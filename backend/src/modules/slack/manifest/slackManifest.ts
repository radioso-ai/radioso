export const slackBotScopes = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "chat:write",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "reactions:write",
  "users:read",
  "users:read.email",
] as const;

export const requiredSlackEnvVars = [
  "SLACK_OAUTH_CLIENT_ID",
  "SLACK_OAUTH_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
] as const;
export type RequiredSlackEnvVar = (typeof requiredSlackEnvVars)[number];

interface SlackReadiness {
  configured: boolean;
  missingEnvVars: RequiredSlackEnvVar[];
}

export const getSlackReadiness = (
  env?: Partial<Record<RequiredSlackEnvVar, string | null | undefined>>,
): SlackReadiness => {
  const missingEnvVars = requiredSlackEnvVars.filter((envVar) => !env?.[envVar]);
  return {
    configured: missingEnvVars.length === 0,
    missingEnvVars,
  };
};

interface SlackAppManifest {
  display_information: {
    name: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    // Lists the app in Slack's agent pane. Prompts are set per workspace at runtime
    // (assistant.threads.setSuggestedPrompts), never here: one app serves every workspace.
    agent_view: {
      agent_description: string;
    };
    app_home: {
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
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
      request_url?: string;
    };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

const normalizeBaseUrl = (appBaseUrl: string): string => appBaseUrl.replace(/\/+$/u, "");

// Shown in Slack's agent pane next to the app name; Slack caps it at 300 characters.
const SLACK_AGENT_DESCRIPTION =
  "Answers from your workspace's knowledge, runs routines, and hands off to a person when a question needs one.";

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
      agent_view: {
        agent_description: SLACK_AGENT_DESCRIPTION,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
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
        // message.channels / message.groups carry un-mentioned channel traffic so a bound
        // channel can answer thread follow-ups (and every message, when configured) without a re-tag.
        // app_home_opened drives the suggested prompts at the top of the Messages tab.
        bot_events: ["app_mention", "message.im", "message.channels", "message.groups", "app_home_opened"],
      },
      interactivity: {
        is_enabled: true,
        request_url: `${baseUrl}/api/connectors/slack/interactivity`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
};
