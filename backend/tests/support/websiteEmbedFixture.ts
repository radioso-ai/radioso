import { defaultWebsiteEmbedSurfaceSettings, type WebsiteEmbedSurfaceSettings } from "../../src/modules/agents/domain.js";

/**
 * A website embed block for a test agent: the domain's defaults with what the test cares about on
 * top, so a field the block gains later needs no edit in every fixture that builds one.
 */
export const websiteEmbedFixture = (overrides: Partial<WebsiteEmbedSurfaceSettings> = {}): WebsiteEmbedSurfaceSettings => ({
  ...defaultWebsiteEmbedSurfaceSettings(),
  ...overrides,
});
