import type {
  WebhookDeliveryOutcomeStatus,
  WebhookDestination,
  WebhookDestinationWithSecret,
} from "./domain.js";
import type {
  WebhookDestinationActor,
  WebhookDestinationService,
} from "./service.js";
import type {
  ResolvedWebhookDestination,
  WebhookDestinationResolver,
  WebhookDestinationResolverContext,
} from "./resolver.js";

export interface WebhookDestinationManagementPort {
  isEncryptionConfigured(): boolean;
  create(input: {
    workspaceId: string;
    name: string;
    url: string;
    actor: WebhookDestinationActor;
  }): Promise<WebhookDestinationWithSecret>;
  list(workspaceId: string): Promise<WebhookDestination[]>;
  get(workspaceId: string, id: string): Promise<WebhookDestination>;
  update(input: {
    workspaceId: string;
    id: string;
    name: string;
    url: string;
    actor: WebhookDestinationActor;
  }): Promise<WebhookDestination>;
  rotateSecret(
    workspaceId: string,
    id: string,
    actor: WebhookDestinationActor,
  ): Promise<WebhookDestinationWithSecret>;
  delete(workspaceId: string, id: string, actor: WebhookDestinationActor): Promise<void>;
}

export interface WebhookDestinationReferencePort {
  existsByIdAndWorkspace(workspaceId: string, destinationId: string): Promise<boolean>;
}

export interface WebhookDestinationDeliveryOutcomePort {
  recordDeliveryOutcome(
    workspaceId: string,
    destinationId: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void>;
}

export type WebhookDestinationRuntimePort =
  WebhookDestinationResolver &
  WebhookDestinationDeliveryOutcomePort;

export type WebhookDestinationPublicAdapter =
  WebhookDestinationManagementPort &
  WebhookDestinationReferencePort &
  WebhookDestinationRuntimePort;

type WebhookDestinationServicePublicSurface = Pick<
  WebhookDestinationService,
  | "isEncryptionConfigured"
  | "create"
  | "list"
  | "get"
  | "update"
  | "rotateSecret"
  | "delete"
  | "existsByIdAndWorkspace"
  | "resolveDestinationWithSecret"
  | "recordDeliveryOutcome"
>;

export class DefaultWebhookDestinationAdapter implements WebhookDestinationPublicAdapter {
  constructor(private readonly service: WebhookDestinationServicePublicSurface) {}

  isEncryptionConfigured(): boolean {
    return this.service.isEncryptionConfigured();
  }

  async create(input: Parameters<WebhookDestinationManagementPort["create"]>[0]): Promise<WebhookDestinationWithSecret> {
    return this.service.create(input);
  }

  async list(workspaceId: string): Promise<WebhookDestination[]> {
    return this.service.list(workspaceId);
  }

  async get(workspaceId: string, id: string): Promise<WebhookDestination> {
    return this.service.get(workspaceId, id);
  }

  async update(input: Parameters<WebhookDestinationManagementPort["update"]>[0]): Promise<WebhookDestination> {
    return this.service.update(input);
  }

  async rotateSecret(
    workspaceId: string,
    id: string,
    actor: WebhookDestinationActor,
  ): Promise<WebhookDestinationWithSecret> {
    return this.service.rotateSecret(workspaceId, id, actor);
  }

  async delete(workspaceId: string, id: string, actor: WebhookDestinationActor): Promise<void> {
    await this.service.delete(workspaceId, id, actor);
  }

  async existsByIdAndWorkspace(workspaceId: string, destinationId: string): Promise<boolean> {
    return this.service.existsByIdAndWorkspace(workspaceId, destinationId);
  }

  async resolve(
    destinationId: string,
    context: WebhookDestinationResolverContext,
  ): Promise<ResolvedWebhookDestination | null> {
    if (!context.workspaceId) {
      return null;
    }
    return this.service.resolveDestinationWithSecret(context.workspaceId, destinationId);
  }

  async recordDeliveryOutcome(
    workspaceId: string,
    destinationId: string,
    status: WebhookDeliveryOutcomeStatus,
  ): Promise<void> {
    await this.service.recordDeliveryOutcome(workspaceId, destinationId, status);
  }
}
