import process from 'node:process';
import {
  launchExtension,
  stamp,
  toggleActiveTabFromServiceWorker,
} from './extension-harness.mjs';

const apiKey = process.env.INWORLD_API_KEY;
const startedAt = Date.now();
const articleUrl =
  process.env.HIGHLIGHTER_REAL_ARTICLE_URL ||
  'https://developer.chrome.com/blog/longer-esw-lifetimes';

if (!apiKey) {
  console.error('INWORLD_API_KEY is required');
  process.exit(1);
}

const extension = await launchExtension({
  apiKey,
  startedAt,
  profilePrefix: 'highlighter-real-article-',
});

try {
  await extension.popupPage.close();

  const page = await extension.context.newPage();
  await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('p', { timeout: 30000 });

  // Match a real user flow: extension reload while an article tab already exists,
  // then page reload so static content scripts and the service worker are fresh.
  await extension.reloadExtension();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('p', { timeout: 30000 });
  await page.bringToFront();

  const toggleResponse = await toggleActiveTabFromServiceWorker(extension.serviceWorker, page.url());
  if (!toggleResponse.ok) {
    throw new Error(`toggle failed: ${JSON.stringify(toggleResponse)}`);
  }
  await page.locator('.highlighter-indicator.visible').waitFor({ timeout: 5000 });

  const textRects = await page.evaluate(() => {
    function visibleParagraphs() {
      return Array.from(document.querySelectorAll('main p, article p, p')).filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 180 &&
          rect.height > 12 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          (el.textContent || '').trim().length > 120
        );
      });
    }

    function findTextNodeRange(el, maxChars) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let startNode = null;
      let endNode = null;
      let endOffset = 0;
      let seen = 0;

      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent || '';
        if (!text.trim()) continue;
        if (!startNode) startNode = node;
        seen += text.length;
        endNode = node;
        endOffset = text.length;
        if (seen >= maxChars) {
          endOffset = Math.max(1, text.length - (seen - maxChars));
          break;
        }
      }

      if (!startNode || !endNode) return null;
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endOffset);
      return Array.from(range.getClientRects())
        .filter((rect) => rect.width > 20 && rect.height > 8)
        .slice(0, 3)
        .map((rect) => ({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }));
    }

    for (const paragraph of visibleParagraphs()) {
      const rects = findTextNodeRange(paragraph, 220);
      if (rects?.length) return rects;
    }
    return [];
  });

  if (!textRects.length) {
    throw new Error('could not find a visible article paragraph text range');
  }

  const first = textRects[0];
  await page.mouse.move(first.x + 6, first.y + first.height / 2);
  await page.mouse.down();
  for (const rect of textRects) {
    await page.mouse.move(rect.x + rect.width - 6, rect.y + rect.height / 2, { steps: 12 });
  }
  await page.mouse.up();

  await page.locator('.hltr-player.hltr-visible').waitFor({ timeout: 8000 });
  await page.locator('.hltr-play-pause').click();
  await page.locator('.hltr-play-pause.hltr-loading').waitFor({ timeout: 8000 });
  await page.locator('.hltr-play-pause.hltr-loading').waitFor({
    state: 'detached',
    timeout: 30000,
  });

  const playerState = await page.locator('.hltr-player').evaluate((el) => ({
    visible: el.classList.contains('hltr-visible'),
    error: el.classList.contains('hltr-error'),
    playTitle: el.querySelector('.hltr-play-pause')?.getAttribute('title'),
  }));

  const debugEvents = await extension.serviceWorker.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.local.get(['debugLog'], (data) => {
          const debugLog = Array.isArray(data.debugLog) ? data.debugLog : [];
          resolve(debugLog.map((entry) => entry.event));
        });
      })
  );

  for (const event of ['tts-request-start', 'tts-complete', 'tts-response']) {
    if (!debugEvents.includes(event)) {
      throw new Error(`missing expected debug event ${event}: ${JSON.stringify(debugEvents.slice(-40))}`);
    }
  }
  if (playerState.error) {
    throw new Error(`player entered error state: ${JSON.stringify(playerState)}`);
  }

  console.log(
    JSON.stringify(
      {
        elapsed: stamp(startedAt),
        extensionId: extension.extensionId,
        articleUrl: page.url(),
        toggleResponse,
        selectedLineCount: textRects.length,
        playerState,
        recentDebugEvents: debugEvents.slice(-20),
      },
      null,
      2
    )
  );
} finally {
  await extension.close();
}
