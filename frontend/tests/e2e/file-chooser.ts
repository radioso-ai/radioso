import type { FileChooser, Page } from "@playwright/test";

/**
 * Presses a key on the focused control and returns the file chooser it opens.
 *
 * Adding a `filechooser` listener makes Playwright send the command that turns chooser interception
 * on, without waiting for it to land. A page whose main thread is busy, as a production page is
 * right after it hydrates, takes the key press ahead of that queued command: the click the key makes
 * opens the browser's own chooser and no event ever reaches the test. A round trip to the page,
 * made after the listener is added, queues behind the command, so interception is on once it
 * returns. A pointer click does not meet this, since its actionability checks are that round trip.
 */
export const pressKeyForFileChooser = async (page: Page, key: string): Promise<FileChooser> => {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    (async () => {
      await page.evaluate(() => undefined);
      await page.keyboard.press(key);
    })(),
  ]);
  return chooser;
};
