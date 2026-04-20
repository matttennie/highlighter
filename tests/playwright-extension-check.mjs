import process from 'node:process';
import {
  launchExtension,
  sendRuntimeMessage,
  startTestServer,
  stamp,
  toggleActiveTabFromServiceWorker,
} from './extension-harness.mjs';

const apiKey = process.env.INWORLD_API_KEY;
const startedAt = Date.now();

if (!apiKey) {
  console.error('INWORLD_API_KEY is required');
  process.exit(1);
}

const server = await startTestServer();
const extension = await launchExtension({ apiKey, startedAt });

try {
  await extension.popupPage.waitForFunction(
    () => document.querySelectorAll('#defaultVoice option').length > 1,
    { timeout: 10000 }
  );

  const voiceOptions = await extension.popupPage.locator('#defaultVoice option').evaluateAll((options) =>
    options.map((option) => ({
      value: option.value,
      text: option.textContent,
    }))
  );

  const voicesResponse = await sendRuntimeMessage(extension.popupPage, { type: 'voices-request' });
  const ttsResponse = await sendRuntimeMessage(extension.popupPage, {
    type: 'tts-request',
    text: 'test',
    voice: 'Sarah',
    speed: 1,
  });
  if (!voicesResponse?.ok || !voicesResponse.voices?.length) {
    throw new Error(`voices request failed: ${JSON.stringify(voicesResponse)}`);
  }
  if (!ttsResponse?.ok || !ttsResponse.audioDataUrl) {
    throw new Error(`tts request failed: ${JSON.stringify(ttsResponse)}`);
  }
  await extension.popupPage.close();

  const testPage = await extension.context.newPage();
  await testPage.goto(server.url);
  await testPage.waitForSelector('#short');
  await testPage.reload();
  await testPage.waitForSelector('#short');
  await testPage.bringToFront();

  await extension.serviceWorker.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.set({ debugLog: [] }, resolve);
      })
  );
  await extension.serviceWorker.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.set(
          {
            debugLog: [
              {
                ts: new Date().toISOString(),
                source: 'test',
                event: 'debug-log-loop-probe',
                details: {},
              },
            ],
          },
          resolve
        );
      })
  );
  await testPage.waitForTimeout(250);
  const debugLoopProbe = await extension.serviceWorker.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get(['debugLog'], (data) => {
          const debugLog = Array.isArray(data.debugLog) ? data.debugLog : [];
          resolve({
            logCount: debugLog.length,
            settingsChangedCount: debugLog.filter((entry) => entry.event === 'settings-changed').length,
          });
        });
      })
  );
  if (debugLoopProbe.settingsChangedCount !== 0) {
    throw new Error(`debugLog storage write triggered settings-changed: ${JSON.stringify(debugLoopProbe)}`);
  }

  const toggleResponse = await toggleActiveTabFromServiceWorker(extension.serviceWorker, testPage.url());
  if (!toggleResponse.ok) {
    throw new Error(`toggle failed: ${JSON.stringify(toggleResponse)}`);
  }
  await testPage.locator('.highlighter-indicator.visible').waitFor({ timeout: 5000 });

  console.log(
    JSON.stringify(
      {
        elapsed: stamp(startedAt),
        extensionId: extension.extensionId,
        testPageUrl: server.url,
        toggleResponse,
        debugLoopProbe,
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
  await extension.close();
  await server.close();
}
