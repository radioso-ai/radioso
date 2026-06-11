import type { WebhookDestinationService } from "./service.js";

export interface WebhookDestinationResolverContext {
  workspaceId?: string | null;
}

export interface ResolvedWebhookDestination {
  url: string;
  secret: string;
}

export interface WebhookDestinationResolver {
  resolve(
    destinationId: string,
    context: WebhookDestinationResolverContext,
  ): Promise<ResolvedWebhookDestination | null>;
}

export class DefaultWebhookDestinationResolver implements WebhookDestinationResolver {
  constructor(private readonly destinations: Pick<WebhookDestinationService, "resolveDestinationWithSecret">) {}

  async resolve(
    destinationId: string,
    context: WebhookDestinationResolverContext,
  ): Promise<ResolvedWebhookDestination | null> {
    if (!context.workspaceId) {
      return null;
    }
    return this.destinations.resolveDestinationWithSecret(context.workspaceId, destinationId);
  }
}

