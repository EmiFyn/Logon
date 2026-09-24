/**
 * The phone must never be stuck on an old server address.
 *
 * This is here because of a fault that took two days to find and thirty seconds to
 * fix. `config.js` holds the address of the Worker. It was cached by the service
 * worker like every other file in the app - kept, served, quietly refreshed for next
 * time - so when the address was corrected at the office and published, the handsets
 * carried on using the copy they already had. Every one of them said "Failed to
 * fetch", which is also what they say with no signal, and the address itself appeared
 * nowhere on the screen.
 *
 * So: config.js comes from the network whenever there is one, and from the cache only
 * when there is not. These checks are that both halves of that are true, because
 * getting the second half wrong would break the offline working that is the whole
 * reason this is an app and not a web page.
 *
 * Run it with a copy of the pwa folder served on http://127.0.0.1:8080 :
 *
 *   node pwa/tests/config-freshness.mjs
 *
 * It needs playwright and nothing else - no Worker, no database.
 */
import { chromium, devices } from 'playwright';
import { writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PWA = join(HERE, '..');

let pass = 0;
let failn = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { failn++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

// --- serve a throwaway copy of the app -------------------------------------

const root = mkdtempSync(join(tmpdir(), 'pwa-'));
cpSync(PWA, root, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(root, path === '/' ? '/index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      // As GitHub Pages does: a copy the browser is entitled to keep for a while.
      // Part of what this is testing is that a correction gets past that too.
      'Cache-Control': 'max-age=600',
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(8080, '127.0.0.1', r));

const config = (api) => `window.WA_CONFIG = {\n  API_BASE: '${api}',\n};\n`;
const WRONG = 'https://whereabouts.oakwicklog.workers.dev';    // one letter short
const RIGHT = 'https://whereabouts.oakwicklogin.workers.dev';
const CONFIG = join(root, 'config.js');

writeFileSync(CONFIG, config(WRONG));

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();

// --- the handset arrives, and the service worker takes over ------------------

await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

check('the service worker is in charge',
  await page.evaluate(() => !!navigator.serviceWorker.controller));

check('the address is on the screen, not just in a file',
  (await page.textContent('#login-api')).trim() === WRONG,
  await page.textContent('#login-api'));

// --- the office corrects it and publishes ------------------------------------
//
// Nothing else changes: same version of the app, same cache name. This is exactly the
// case that stranded every handset.

writeFileSync(CONFIG, config(RIGHT));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

check('a corrected address reaches the handset on the next load',
  (await page.textContent('#login-api')).trim() === RIGHT,
  await page.textContent('#login-api'));

// window.WA_CONFIG is whatever the file that loaded said; the address the app will
// actually call is the one it corrected itself to, which is what is on the screen.
check('and it is what the app would actually call',
  (await page.textContent('#login-api')).trim() === RIGHT,
  await page.textContent('#login-api'));

// --- but the app still has to work with no signal ----------------------------
//
// The reason anything is cached is that these crews work where there is none. A
// config that only ever came from the network would be worse than the bug it fixes.

await ctx.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(1500);

check('the app still opens with no signal at all',
  await page.isVisible('#login-form').catch(() => false));

check('and uses the last address it was told about',
  (await page.textContent('#login-api').catch(() => '')).trim() === RIGHT,
  await page.textContent('#login-api').catch(() => '(nothing)'));

await ctx.setOffline(false);

// --- and when it fails, it says what it tried --------------------------------

writeFileSync(CONFIG, config('https://nothing-is-deployed-here.invalid'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.fill('#email', 'someone@example.com');
await page.fill('#password', 'whatever-it-is');
await page.click('#login-go');
await page.waitForTimeout(3000);

const msg = (await page.textContent('#login-msg')).trim();
check('a failure names the address it could not reach',
  msg.includes('nothing-is-deployed-here.invalid'), msg.slice(0, 120));
check('and does not just say "Failed to fetch"',
  !/^Failed to fetch$/i.test(msg), msg.slice(0, 120));
check('and the panel opens itself, rather than waiting to be found',
  (await page.getAttribute('#login-where', 'open')) !== null);

await browser.close();
server.close();

console.log('\n' + pass + ' passed, ' + failn + ' failed');
process.exit(failn ? 1 : 0);
