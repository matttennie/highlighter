import process from 'node:process';
import {
  launchExtension,
  startTestServer,
  stamp,
  toggleActiveTabFromServiceWorker,
} from './extension-harness.mjs';

const apiKey = process.env.ELEVENLABS_API_KEY;
const startedAt = Date.now();

if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is required');
  process.exit(1);
}

const server = await startTestServer();
const extension = await launchExtension({
  apiKey,
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

  console.log(
    JSON.stringify(
      {
        elapsed: stamp(startedAt),
        extensionId: extension.extensionId,
        testPageUrl: server.url,
        toggleResponse,
        playerState,
      },
      null,
      2
    )
  );
} finally {
  await extension.close();
  await server.close();
}
