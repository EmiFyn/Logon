/**
 * The second dropdown, and the reminder behind it.
 *
 * Cutting is either live or on a shutdown, and if it is live the crew has to log on
 * with control as well. That reminder is the only thing in this app that deliberately
 * stops somebody, so it is worth being sure it appears, that it cannot be scrolled
 * past, and that it never appears when it should not.
 *
 * One of these checks exists because of a bug that would have shipped: the dialog's
 * `display: flex` beat the browser's own rule for `hidden`, leaving an invisible sheet
 * of glass over the whole app that swallowed every tap. Nothing was visibly wrong.
 * Only a test trying to press Sign in caught it.
 *
 * Needs a copy of the pwa folder on http://127.0.0.1:8080 and a Worker on :8787 with
 * a crew account:
 *
 *   node pwa/tests/work-options.mjs <email> <password>
 */
import { chromium, devices } from 'playwright';

const [EMAIL, PASSWORD] = [process.argv[2] || 'crew@example.com',
  process.argv[3] || 'crew-pass-123'];

let pass = 0;
let failn = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { failn++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'networkidle' });

// The overlay is hidden at this point. If it is covering the page, this click times
// out - which is exactly how the bug above was found.
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
await page.click('#login-go', { timeout: 15000 });
await page.waitForSelector('#view-main:not([hidden])', { timeout: 20000 });
await page.waitForTimeout(2000);

check('a hidden dialog does not block the page underneath it', true);

// --- the dropdown only appears when there is something to choose -------------

check('no second dropdown before a work type is picked',
  await page.isHidden('#detail-wrap'));

await page.selectOption('#work-type', 'SURVEYING');
await page.waitForTimeout(300);
check('none for a work type with no choices', await page.isHidden('#detail-wrap'));

await page.selectOption('#work-type', 'CUTTING');
await page.waitForTimeout(300);
check('but there is one for cutting', await page.isVisible('#detail-wrap'));

const options = await page.$$eval('#work-detail option', (o) => o.map((x) => x.textContent));
check('with the choices the office set',
  options.includes('Live') && options.includes('Shutdown'), options.join('/'));
check('and nothing chosen for them', await page.inputValue('#work-detail') === '');

// --- the reminder ------------------------------------------------------------

await page.selectOption('#work-detail', 'Shutdown');
await page.waitForTimeout(500);
check('a shutdown does not interrupt anybody', await page.isHidden('#remind-overlay'));

await page.selectOption('#work-detail', 'Live');
await page.waitForTimeout(600);
check('live does', await page.isVisible('#remind-overlay'));

const said = (await page.textContent('#remind-text')).trim();
check('and says what to do about it', /control/i.test(said), said);

// It has to be tapped. A message that goes away on its own is a message nobody has
// necessarily read, which defeats the point of having it.
await page.waitForTimeout(3000);
check('it does not slide away by itself', await page.isVisible('#remind-overlay'));

await page.click('#remind-ok');
await page.waitForTimeout(400);
check('tapping it clears it', await page.isHidden('#remind-overlay'));
check('and the page works again afterwards',
  await page.isVisible('#work-detail'));

check('the warning stays on the form as well',
  /control/i.test((await page.textContent('#detail-hint')).trim()));

// --- it will not send without a choice ---------------------------------------

await page.selectOption('#work-type', 'CUTTING');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const cb = document.querySelector('#people input[type=checkbox]');
  if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.selectOption('#work-detail', '');
await page.click('#send');
await page.waitForTimeout(800);
const toast = (await page.textContent('#toast')).trim();
check('a logon will not go without one of the choices',
  /live or shutdown/i.test(toast), toast);

console.log('\nerrors on the page: ' + (errors.length ? errors.join('; ') : 'none'));
if (errors.length) failn += 1;

await browser.close();
console.log('\n' + pass + ' passed, ' + failn + ' failed');
process.exit(failn ? 1 : 0);
