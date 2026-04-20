import process from 'node:process';
import {
  attachHighlighterConsole,
  launchExtension,
  startTestServer,
  stamp,
} from './extension-harness.mjs';

const apiKey = process.env.INWORLD_API_KEY;
const startedAt = Date.now();

if (!apiKey) {
  console.error('INWORLD_API_KEY is required');
  process.exit(1);
}

const server = await startTestServer();
const extension = await launchExtension({
  apiKey,
  startedAt,
  profilePrefix: 'highlighter-watch-',
});

const testPage = await extension.context.newPage();
attachHighlighterConsole(testPage, '[test-page]', startedAt);
await testPage.goto(server.url);
await testPage.waitForSelector('#short');

console.error(`${stamp(startedAt)} watching extension ${extension.extensionId}`);
console.error(`${stamp(startedAt)} test page URL: ${server.url}`);
console.error(`${stamp(startedAt)} popup and reload-safe test page are open`);
console.error(`${stamp(startedAt)} press Ctrl-C in this terminal to stop watching`);

process.on('SIGINT', async () => {
  console.error(`\n${stamp(startedAt)} stopping watcher`);
  await extension.close();
  await server.close();
  process.exit(0);
});

await new Promise(() => {});
