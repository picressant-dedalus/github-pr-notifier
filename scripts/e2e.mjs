// End-to-end smoke test against the real GitHub API, in a real Chrome with the unpacked extension.
// Configures the extension through the options page, waits for the background refresh, checks
// the toolbar badge and takes screenshots of both pages into docs/screenshots/.
//
// Usage: GITHUB_TOKEN=ghp_xxx [E2E_REPOS="orme-pharmacy,other"] [E2E_MIN_AGE_DAYS=2]
//        [CHROME_PATH=/usr/bin/google-chrome] npm run e2e
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.GITHUB_TOKEN;
const repos = (process.env.E2E_REPOS || 'orme-pharmacy').split(',').map((r) => r.trim()).filter(Boolean);
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  pipe: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    '--no-sandbox',
    // Chrome >= 137 ignores --load-extension unless this feature is disabled
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`
  ]
});

try {
  const worker = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/js/background.js'),
    { timeout: 15000 }
  );
  const id = new URL(worker.url()).host;
  console.log('Extension loaded:', id);

  const options = await browser.newPage();
  await options.setViewport({ width: 900, height: 900 });
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.getElementById('org').value !== '');
  await options.type('#repos', repos.join('\n'));
  await options.type('#token', token);
  if (process.env.E2E_MIN_AGE_DAYS) {
    await options.$eval('#badgeMinAgeDays', (input) => { input.value = ''; });
    await options.type('#badgeMinAgeDays', process.env.E2E_MIN_AGE_DAYS);
  }
  await options.click('#test');
  await options.waitForFunction((n) => document.querySelectorAll('#test-result li').length === n, { timeout: 30000 }, repos.length + 1);
  console.log('Connection test:', await options.$$eval('#test-result li', (items) => items.map((i) => i.textContent)));
  await options.click('button[type=submit]');
  await options.waitForFunction(() => document.getElementById('status').textContent.startsWith('Saved'));
  await options.screenshot({ path: join(root, 'docs/screenshots/options.png') });

  // Reopening the settings must list every configured repository
  await options.reload();
  await options.waitForFunction(() => document.getElementById('repos').value !== '');
  const listed = (await options.$eval('#repos', (t) => t.value)).split('\n');
  if (listed.length !== repos.length) {
    throw new Error(`Settings reopened with ${listed.length} repositories instead of ${repos.length}: ${listed}`);
  }
  console.log('Settings reopened with all repositories:', listed);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(async () => {
    const { state } = await chrome.storage.local.get('state');
    return Boolean(state && state.lastUpdated && !state.refreshing);
  }, { timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const badge = await popup.evaluate(async () => ({
    text: await chrome.action.getBadgeText({}),
    title: await chrome.action.getTitle({})
  }));
  console.log('Badge:', badge);
  const height = await popup.evaluate(() => document.body.scrollHeight);
  await popup.setViewport({ width: 520, height: Math.min(height, 1400) });
  await popup.screenshot({ path: join(root, 'docs/screenshots/popup.png') });
  console.log('Cards:', await popup.$$eval('.pr-card', (cards) => cards.length));

  // With a minimum age, the "Older than Nd" tab must list exactly the PRs counted on the badge
  if (await popup.$('.filter-old')) {
    await popup.click('.filter-old');
    await popup.waitForSelector('.filter-old.active');
    const oldCards = await popup.$$eval('.pr-card', (cards) => cards.length);
    const oldCount = await popup.$eval('.filter-old .count', (c) => Number(c.textContent));
    console.log('Old PR cards:', oldCards, '/ tab count:', oldCount);
    if (oldCards !== oldCount) throw new Error(`"old" tab shows ${oldCards} cards but counts ${oldCount}`);
    await popup.screenshot({ path: join(root, 'docs/screenshots/popup-old.png') });
    await popup.click('.filter-all');
  }
  console.log('Screenshots written to docs/screenshots/');
} finally {
  await browser.close();
}
