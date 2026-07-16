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
  profilePrefix: 'highlighter-player-lifecycle-',
});

async function strokeShortParagraph(page, { keepMode = false } = {}) {
  const box = await page.locator('#short').evaluate((element) => {
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent.length);
    const rect = range.getClientRects()[0];
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  });
  if (!box) throw new Error('missing short paragraph text rectangle');

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, y, { steps: 12 });
  if (keepMode) await page.keyboard.down('Shift');
  await page.mouse.up();
  if (keepMode) await page.keyboard.up('Shift');
}

try {
  await extension.popupPage.close();
  const page = await extension.context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(server.url);
  await page.waitForSelector('#short');
  await page.bringToFront();

  const toggleResponse = await toggleActiveTabFromServiceWorker(extension.serviceWorker, page.url());
  if (!toggleResponse.ok) throw new Error(`toggle failed: ${JSON.stringify(toggleResponse)}`);
  await page.locator('.highlighter-indicator.visible').waitFor({ timeout: 5000 });

  // Keep Highlight Mode active, close the first player, then reload the
  // unpacked extension. The stale page context must still reveal a player
  // rather than throwing when Chrome removes chrome.storage/runtime.
  await strokeShortParagraph(page, { keepMode: true });
  await page.locator('.hltr-player.hltr-visible').waitFor({ timeout: 5000 });
  await page.locator('.hltr-close-btn').click();
  await page.locator('.hltr-player.hltr-visible').waitFor({ state: 'detached', timeout: 5000 });

  await extension.reloadExtension();
  await page.bringToFront();
  await strokeShortParagraph(page, { keepMode: true });
  await page.locator('.hltr-player.hltr-visible').waitFor({ timeout: 5000 });
  await page.getByText('Extension was reloaded', { exact: false }).waitFor({ timeout: 5000 });

  const state = await page.locator('.hltr-player').evaluate((player) => ({
    visible: player.classList.contains('hltr-visible'),
    selection: getSelection()?.toString() || '',
    cursorVisible: getComputedStyle(document.querySelector('.highlighter-cursor')).display === 'block',
  }));
  if (pageErrors.length) throw new Error(`page errors after reload: ${JSON.stringify(pageErrors)}`);

  console.log(JSON.stringify({
    elapsed: stamp(startedAt),
    extensionId: extension.extensionId,
    toggleResponse,
    state,
    pageErrors,
  }, null, 2));
} finally {
  await extension.close();
  await server.close();
}
