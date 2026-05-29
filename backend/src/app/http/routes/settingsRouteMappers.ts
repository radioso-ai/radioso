import type { z } from "zod";

import type { PlatformSettingsPatch } from "../../../modules/settings/contracts/platform.js";
import type {
  updateGeneralSettingsSchema,
  updateSettingsSchema,
} from "./settingsRouteSchemas.js";

type RetrievalSettingsPatch = NonNullable<PlatformSettingsPatch["retrieval"]>;
type ChannelSettingsPatch = NonNullable<PlatformSettingsPatch["channels"]>;

export const toRetrievalSettingsPatch = (
  body: z.infer<typeof updateSettingsSchema>,
): PlatformSettingsPatch => ({
  assistant: {
    suggestedQuestionsEnabled: body.suggestedQuestionsEnabled,
    customInstruction: body.customInstruction,
  },
  retrieval: {
    queryRewriteEnabled: body.queryRewriteEnabled,
    semanticRewriteInstructions: body.semanticRewriteInstructions,
    lexicalRewriteInstructions: body.lexicalRewriteInstructions,
    rerankEnabled: body.rerankEnabled,
    vectorTopK: body.vectorTopK,
    similarityThreshold: body.similarityThreshold,
    rerankTopK: body.rerankTopK,
    citationDisplayEnabled: body.citationDisplayEnabled,
    metadataRules: body.metadataRules as RetrievalSettingsPatch["metadataRules"],
    retrievalStrategy: body.retrievalStrategy,
  },
});

export const toGeneralSettingsPatch = (
  body: z.infer<typeof updateGeneralSettingsSchema>,
): PlatformSettingsPatch => ({
  assistant: {
    assistantName: body.assistantName,
    greetingInstruction: body.greetingInstruction,
    assistantDefaultLocale: body.assistantDefaultLocale,
    proactiveGreetingEnabled: body.proactiveGreetingEnabled,
  },
  channels: {
    anonymousChatEnabled: body.anonymousChatEnabled,
    websiteEmbedEnabled: body.websiteEmbedEnabled,
    websiteEmbedAllowedOrigins: body.websiteEmbedAllowedOrigins,
    websiteEmbedLauncherLabel: body.websiteEmbedLauncherLabel,
    websiteEmbedLauncherPosition: body.websiteEmbedLauncherPosition,
    websiteEmbedTheme: body.websiteEmbedTheme as ChannelSettingsPatch["websiteEmbedTheme"],
    websiteEmbedCopy: body.websiteEmbedCopy,
    websiteEmbedExpertOverrides: body.websiteEmbedExpertOverrides,
  },
});

export const anonymousChatTokenRotationPatch = (): PlatformSettingsPatch => ({
  channels: {
    rotateAnonymousChatToken: true,
  },
});

export const websiteEmbedTokenRotationPatch = (): PlatformSettingsPatch => ({
  channels: {
    rotateWebsiteEmbedToken: true,
  },
});
