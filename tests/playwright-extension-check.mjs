import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const userDataDir = '/tmp/highlighter-playwright-profile';
const apiKey = process.env.ELEVENLABS_API_KEY;

if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is required');
  process.exit(1);
}

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${rootDir}`,
    `--load-extension=${rootDir}`,
  ],
});

try {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  }

  const extensionId = new URL(serviceWorker.url()).host;
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  await popupPage.evaluate(
    async ({ key }) => {
      await chrome.storage.local.set({
        apiKey: key,
        elApiKey: key,
        modelId: 'eleven_turbo_v2_5',
        defaultVoice: 'JBFqnCBsd6RMkjVDRZzb',
      });
    },
    { key: apiKey }
  );

  await popupPage.reload();
  await popupPage.waitForTimeout(1500);

  const voiceOptions = await popupPage.locator('#defaultVoice option').evaluateAll((options) =>
    options.map((option) => ({
      value: option.value,
      text: option.textContent,
    }))
  );

  const voicesResponse = await popupPage.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'voices-request' });
  });

  const ttsResponse = await popupPage.evaluate(async () => {
    return chrome.runtime.sendMessage({
      type: 'tts-request',
      text: 'test',
      voice: 'JBFqnCBsd6RMkjVDRZzb',
      speed: 1,
    });
  });

  console.log(
    JSON.stringify(
      {
        extensionId,
        voiceOptions,
        voicesResponse,
        ttsResponse: {
          ok: ttsResponse?.ok ?? false,
          error: ttsResponse?.error ?? null,
          status: ttsResponse?.status ?? null,
          detail: ttsResponse?.detail ?? null,
          audioDataUrlPrefix: ttsResponse?.audioDataUrl?.slice(0, 32) ?? null,
        },
      },
      null,
      2
    )
  );
} finally {
  await context.close();
}
