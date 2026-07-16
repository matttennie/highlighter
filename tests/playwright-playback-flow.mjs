import {
  launchExtension,
  startTestServer,
  stamp,
  toggleActiveTabFromServiceWorker,
} from './extension-harness.mjs';

const startedAt = Date.now();

const server = await startTestServer();
const extension = await launchExtension({
  startedAt,
  profilePrefix: 'highlighter-playback-',
});

try {
  await extension.popupPage.close();
  const page = await extension.context.newPage();
  await page.goto(server.url);
  await page.waitForSelector('#short');
  await page.bringToFront();

  const toggleResponse = await toggleActiveTabFromServiceWorker(extension.serviceWorker, page.url());
  if (!toggleResponse.ok) {
    throw new Error(`toggle failed: ${JSON.stringify(toggleResponse)}`);
  }
  await page.locator('.highlighter-indicator.visible').waitFor({ timeout: 5000 });

  const box = await page.locator('#short').evaluate((el) => {
    const textNode = el.firstChild;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.textContent.length);
    const rect = range.getClientRects()[0];
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  });
  if (!box) throw new Error('missing short paragraph text rectangle');

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, y, { steps: 16 });
  await page.mouse.up();

  await page.locator('.hltr-player.hltr-visible').waitFor({ timeout: 5000 });
  await page.locator('.hltr-play-pause').click();
  await page.locator('.hltr-play-pause.hltr-loading').waitFor({ timeout: 5000 });
  await page.locator('.hltr-play-pause.hltr-loading').waitFor({
    state: 'detached',
    timeout: 15000,
  });

  const playerState = await page.locator('.hltr-player').evaluate((el) => ({
    visible: el.classList.contains('hltr-visible'),
    error: el.classList.contains('hltr-error'),
    playTitle: el.querySelector('.hltr-play-pause')?.getAttribute('title'),
  }));

  if (playerState.error) {
    throw new Error(`player entered error state: ${JSON.stringify(playerState)}`);
  }

  // Let the one-sentence selection finish, then replay it. The second play
  // must use the decoded Blob cache rather than synthesize/decode base64 again.
  await page.locator('.hltr-play-pause[title="Play"]').waitFor({ timeout: 10000 });
  await page.locator('.hltr-play-pause').click();
  await page.locator('.hltr-play-pause[title="Pause"]').waitFor({ timeout: 5000 });
  // Content debug events are flushed to extension storage in batches, so poll
  // until the cache-hit event reaches storage rather than racing that flush.
  const cacheEvidence = await extension.serviceWorker.evaluate(
    () => new Promise((resolve) => {
      const deadline = Date.now() + 4000;
      const inspect = () => {
        chrome.storage.local.get(['debugLog'], (data) => {
          const entries = Array.isArray(data.debugLog) ? data.debugLog : [];
          const evidence = {
            cacheHits: entries.filter((entry) => entry.event === 'tts-cache-hit').length,
            synthStarts: entries.filter((entry) => entry.event === 'tts-request-start').length,
          };
          if (evidence.cacheHits > 0 || Date.now() >= deadline) {
            resolve(evidence);
            return;
          }
          setTimeout(inspect, 100);
        });
      };
      inspect();
    })
  );
  if (cacheEvidence.cacheHits < 1 || cacheEvidence.synthStarts !== 1) {
    throw new Error(`replay missed decoded audio cache: ${JSON.stringify(cacheEvidence)}`);
  }

  console.log(
    JSON.stringify(
      {
        elapsed: stamp(startedAt),
        extensionId: extension.extensionId,
        testPageUrl: server.url,
        toggleResponse,
        playerState,
        cacheEvidence,
      },
      null,
      2
    )
  );
} finally {
  await extension.close();
  await server.close();
}
