import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { chromium } from 'playwright';

export const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const testHtml = `
<!doctype html>
<html>
  <head>
    <title>Highlighter Test Page</title>
    <style>
      body {
        margin: 48px auto;
        max-width: 760px;
        font: 20px/1.65 Georgia, serif;
        color: #18202a;
        background:
          radial-gradient(circle at 15% 15%, rgba(180, 130, 255, .28), transparent 28rem),
          linear-gradient(135deg, #f8fbff, #eef4eb);
      }
      p { margin: 0 0 28px; }
    </style>
  </head>
  <body>
    <h1>Highlighter Test Page</h1>
    <p id="short">This is a short automated playback test.</p>
    <p id="long">This page is here so the extension can be tested while the terminal streams verbose logs. Highlight this sentence and press play to watch the request lifecycle. The player should advance between sentences without getting stuck in loading.</p>
  </body>
</html>
`;

export function stamp(startedAt) {
  return `+${String(Date.now() - startedAt).padStart(6, ' ')}ms`;
}

export function attachHighlighterConsole(page, source, startedAt) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (!text.includes('Highlighter')) return;
    console.error(`${stamp(startedAt)} ${source} ${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => {
    console.error(`${stamp(startedAt)} ${source}-error ${err.stack || err.message}`);
  });
}

export async function startTestServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(testHtml);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    url: `http://127.0.0.1:${address.port}/index.html`,
  };
}

export async function launchExtension({ apiKey, startedAt, profilePrefix = 'highlighter-e2e-' }) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), profilePrefix));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--disable-crash-reporter',
      '--disable-crashpad',
      `--disable-extensions-except=${rootDir}`,
      `--load-extension=${rootDir}`,
    ],
  });

  context.on('page', (page) => attachHighlighterConsole(page, '[page]', startedAt));

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30000 });
  }
  const attachServiceWorkerConsole = (worker) => worker.on('console', (msg) => {
    const text = msg.text();
    if (!text.includes('Highlighter')) return;
    console.error(`${stamp(startedAt)} [service-worker] ${msg.type()}: ${text}`);
  });
  attachServiceWorkerConsole(serviceWorker);

  const extensionId = new URL(serviceWorker.url()).host;
  const popupPage = await context.newPage();
  attachHighlighterConsole(popupPage, '[popup]', startedAt);
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.evaluate(
    async ({ key }) => {
      await chrome.storage.local.set({
        apiKey: key,
        elApiKey: key,
        modelId: 'eleven_flash_v2_5',
        defaultVoice: 'JBFqnCBsd6RMkjVDRZzb',
        defaultSpeed: '1',
      });
    },
    { key: apiKey }
  );
  await popupPage.reload();

  return {
    context,
    extensionId,
    popupPage,
    get serviceWorker() {
      return serviceWorker;
    },
    userDataDir,
    async reloadExtension() {
      const previousUrl = serviceWorker.url();
      const extensionId = new URL(previousUrl).host;
      const extensionsPage = await context.newPage();
      await extensionsPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
      await extensionsPage.evaluate(async (targetExtensionId) => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const manager = document.querySelector('extensions-manager');
        const managerRoot = manager?.shadowRoot;
        const toolbar = managerRoot?.querySelector('extensions-toolbar');
        const devToggle = toolbar?.shadowRoot?.querySelector('#devMode');
        if (devToggle && !devToggle.checked) {
          devToggle.click();
          await delay(250);
        }

        const itemList = managerRoot?.querySelector('extensions-item-list');
        const itemRoot = itemList?.shadowRoot;
        const item =
          itemRoot?.querySelector(`extensions-item[id="${targetExtensionId}"]`) ||
          Array.from(itemRoot?.querySelectorAll('extensions-item') || []).find(
            (candidate) => candidate.id === targetExtensionId
          );
        const reloadButton = item?.shadowRoot?.querySelector('#dev-reload-button');
        if (!reloadButton) {
          throw new Error(`could not find reload button for ${targetExtensionId}`);
        }
        reloadButton.click();
      }, extensionId);
      await extensionsPage.close().catch(() => {});
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const worker = context.serviceWorkers().find((candidate) => candidate.url() === previousUrl);
        if (worker) {
          try {
            await worker.evaluate(() => chrome.runtime.id);
            serviceWorker = worker;
            attachServiceWorkerConsole(serviceWorker);
            return serviceWorker;
          } catch {
            // The old worker object can remain briefly after reload; wait for a live one.
          }
        }
        try {
          const worker = await context.waitForEvent('serviceworker', {
            timeout: 1000,
            predicate: (candidate) => candidate.url() === previousUrl,
          });
          serviceWorker = worker;
          attachServiceWorkerConsole(serviceWorker);
          return serviceWorker;
        } catch {
          // MV3 workers restart on their own schedule; keep polling until the deadline.
        }
      }
      throw new Error('timed out waiting for extension service worker after reload');
    },
    async close() {
      await context.close();
      await rm(userDataDir, { force: true, recursive: true });
    },
  };
}

export async function sendRuntimeMessage(page, message) {
  return page.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
}

export async function toggleActiveTabFromServiceWorker(serviceWorker, url) {
  return serviceWorker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tabs[0]?.id;
    if (!Number.isInteger(tabId)) {
      return { ok: false, error: 'tab-not-found' };
    }
    const activeUrl = tabs[0]?.url || null;
    if (targetUrl && activeUrl && activeUrl !== targetUrl) {
      return { ok: false, error: 'active-tab-mismatch', activeUrl, targetUrl, tabId };
    }

    const response = await globalThis.__highlighterTestHooks.toggleActiveTab();
    return { ...response, activeUrl };
  }, url);
}
