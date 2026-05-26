import type {
  ChatIntakeProvider,
  ContactHistoryDetail,
  ContactHistoryProvider,
} from "../radiosoModuleTypes.js";
import { HumanContactDeliveryDispatcher } from "./contactDeliveryDispatcher.js";
import { HumanContactHistoryService } from "./contactHistoryService.js";
import { HumanContactRequestExecutor, type HumanContactSubmitInput } from "./contactRequestExecutor.js";
import { HumanContactSettingsService } from "./contactSettingsService.js";
import { createHumanContactSkillSubmissionRepository } from "./contactSkillSubmissionRepository.js";
import type { HumanContactDependencies } from "./humanContactTypes.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
} from "./humanContactTypes.js";
import { HumanContactSkillIntakeProvider } from "./skill/humanContactIntakeProvider.js";
import type { HumanContactSettingsProvider } from "./humanContactContracts.js";

export class EnterpriseHumanContactService {
  private readonly settingsService: HumanContactSettingsService;
  private readonly historyService: HumanContactHistoryService;
  private readonly requestExecutor: HumanContactRequestExecutor;
  private readonly deliveryDispatcher: HumanContactDeliveryDispatcher;
  private readonly intakeProvider: HumanContactSkillIntakeProvider;
  private readonly pollInterval?: NodeJS.Timeout;

  constructor(private readonly input: HumanContactDependencies) {
    this.settingsService = new HumanContactSettingsService({
      database: input.database,
      auditService: input.auditService,
    });
    const submissions = createHumanContactSkillSubmissionRepository(input.database, {
      logger: input.logger,
      auditService: input.auditService,
    });
    this.deliveryDispatcher = new HumanContactDeliveryDispatcher({
      submissions,
      logger: input.logger,
      settingsService: this.settingsService,
      mailService: input.mailService,
      messageRepository: input.messageRepository,
      workspaceContactInfoRepository: input.workspaceContactInfoRepository,
      dashboardBaseUrl: input.dashboardBaseUrl ?? null,
      webhookFetch: input.webhookFetch,
    });
    this.requestExecutor = new HumanContactRequestExecutor({
      database: input.database,
      settingsService: this.settingsService,
      submissions,
      conversationRepository: input.conversationRepository,
      auditService: input.auditService,
      abuseControlService: input.abuseControlService,
      processDueDeliveries: (limit) => this.processDueDeliveries(limit),
    });
    this.historyService = new HumanContactHistoryService(submissions);
    this.intakeProvider = new HumanContactSkillIntakeProvider({
      database: input.database,
      settingsService: this.settingsService,
      requestExecutor: this.requestExecutor,
      chatGateway: input.chatGateway,
    });

    if (input.startPoller ?? true) {
      const intervalMs = input.pollIntervalMs ?? Number(process.env.EE_HUMAN_CONTACT_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
      this.pollInterval = setInterval(() => {
        void this.processDueDeliveries().catch((error) => {
          this.input.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "Human contact delivery poll failed",
          );
        });
      }, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_POLL_INTERVAL_MS);
      this.pollInterval.unref?.();
    }
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  asChatIntakeProvider(): ChatIntakeProvider {
    return {
      handle: (input) => this.intakeProvider.handle(input),
      getPublicIntakeActions: (input) => this.intakeProvider.getPublicIntakeActions(input),
    };
  }

  asContactHistoryProvider(): ContactHistoryProvider {
    return {
      listPageByWorkspaceId: (workspaceId, input) => this.historyService.listPageByWorkspaceId(workspaceId, input),
      getById: (workspaceId, requestId) => this.historyService.getById(workspaceId, requestId),
    };
  }

  asSettingsProvider(): HumanContactSettingsProvider {
    return {
      getSettings: (input) => this.settingsService.getSettings(input),
      updateSettings: (input) => this.settingsService.updateSettings(input),
      revealSigningSecret: (input) => this.settingsService.revealSigningSecret(input),
    };
  }

  async handle(input: Parameters<ChatIntakeProvider["handle"]>[0]) {
    return this.intakeProvider.handle(input);
  }

  async getAvailability(input: { workspaceId: string }) {
    return this.settingsService.getAvailability(input);
  }

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ) {
    return this.historyService.listPageByWorkspaceId(workspaceId, input);
  }

  async getById(workspaceId: string, requestId: string): Promise<ContactHistoryDetail | null> {
    return this.historyService.getById(workspaceId, requestId);
  }

  async getSettings(input: { workspaceId: string; accountId?: string | null }) {
    return this.settingsService.getSettings(input);
  }

  async updateSettings(input: {
    workspaceId: string;
    accountId?: string | null;
    enabled: boolean;
    emailEnabled?: boolean;
    defaultEmail?: string | null;
    defaultEmails?: string[] | null;
    webhookEnabled?: boolean;
    webhookUrl?: string | null;
    signingSecret?: string | null;
    rotateSigningSecret?: boolean;
  }) {
    return this.settingsService.updateSettings(input);
  }

  async revealSigningSecret(input: { workspaceId: string }) {
    return this.settingsService.revealSigningSecret(input);
  }

  async submit(input: HumanContactSubmitInput) {
    return this.requestExecutor.submit(input);
  }

  async processDueDeliveries(limit = 25): Promise<number> {
    return this.deliveryDispatcher.processDueDeliveries(limit);
  }
}
