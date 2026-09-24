/* Site Logon - the field app.
 *
 * Two things this has to get right, because the crews work in places with no signal:
 *   1. The form must open and be fillable with the phone completely offline.
 *   2. A logon must never be lost. It goes into a queue on the phone first, and only
 *      leaves the queue when the server has said, in words, that it stored it.
 *
 * The dropdowns follow the network: voltage narrows the CMRs, a CMR narrows the
 * functional locations, and the area comes from whichever location is picked. The
 * locations for a CMR are downloaded once and kept, so a crew working their usual
 * patch has them from day two whether they have signal or not.
 */

(() => {
  'use strict';

  // The version lives here rather than in config.js. config.js holds the address of
  // your Worker and nothing else, so that replacing the project files can never
  // overwrite it - which is exactly how a working installation once ended up pointed
  // at a hostname that did not exist.
  const APP_VERSION = '1.6.0';

  const CFG = window.WA_CONFIG || {};

  // Not const. The address can be corrected by the office while a handset still holds
  // the old one, and the phone has to be able to pick that up - see refreshAddress().
  let API = (CFG.API_BASE || '').replace(/\/+$/, '');

  const KEY_TOKEN = 'wa.token';
  const KEY_USER = 'wa.user';
  const KEY_LISTS = 'wa.lists';
  const MAX_MATCHES = 60;

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ the day
  //
  // Crews on standby and early starts fill this in the night before, so the form has
  // to offer tomorrow without making anybody drive a date picker in the dark. After
  // five it opens on tomorrow by itself, on the reasoning that somebody filling it in
  // the evening is planning, not reporting - and it says which day it means in words
  // either way, so an assumption is never silent.
  const EVENING_FROM = 17;   // 5pm

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                     'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

  const localDate = (d) => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');

  function dayOffset(days) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);          // midday, so a clock change cannot shift the day
    d.setDate(d.getDate() + days);
    return localDate(d);
  }

  function inWords(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const when = new Date(y, m - 1, d, 12);
    return DAY_NAMES[when.getDay()] + ' ' + d + ' ' + MONTHS[m - 1];
  }

  function drawDay() {
    const value = $('work-date').value;
    const today = dayOffset(0);
    const tomorrow = dayOffset(1);
    $('day-today').setAttribute('aria-pressed', String(value === today));
    $('day-tomorrow').setAttribute('aria-pressed', String(value === tomorrow));

    const hint = $('day-hint');
    hint.classList.toggle('ahead', value === tomorrow);
    if (!value) hint.textContent = '';
    else if (value === today) hint.textContent = 'Today, ' + inWords(value) + '.';
    else if (value === tomorrow) {
      hint.textContent = 'This logon is for TOMORROW, ' + inWords(value) + '.';
    } else if (value > tomorrow) {
      hint.textContent = inWords(value)
        + ' - further ahead than tomorrow, which will not be accepted.';
      hint.classList.add('ahead');
    } else {
      hint.textContent = inWords(value) + ' - a day that has already passed.';
      hint.classList.add('ahead');
    }
  }

  function setDay(iso) {
    $('work-date').value = iso;
    drawDay();
  }

  /** Today, or tomorrow if it is already evening. */
  function openingDay() {
    return dayOffset(new Date().getHours() >= EVENING_FROM ? 1 : 0);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let token = store.get(KEY_TOKEN, '');
  let user = store.get(KEY_USER, null);
  let lists = store.get(KEY_LISTS, { operatives: [], work_types: [], voltages: [], lookup_version: '0' });
  let extraPeople = [];        // names typed in for someone not on the roster
  let cmrsForVoltage = [];     // {cmr, area}
  let locations = [];          // {fl, area} for the chosen CMR
  let chosenFl = null;

  // ------------------------------------------------------------------ storage
  //
  // IndexedDB rather than localStorage: localStorage is synchronous, small, and the
  // first thing a phone throws away under pressure. The outbox is the only copy of a
  // logon between the crew pressing send and the server accepting it, and the lookup
  // cache is what makes the dropdowns work down a lane with no bars.

  const DB_NAME = 'whereabouts';
  const OUTBOX = 'outbox';
  const META = 'meta';
  const LOOKUPS = 'lookups';
  const EDITS = 'edits';
  let dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(OUTBOX)) d.createObjectStore(OUTBOX, { keyPath: 'id' });
        // The service worker cannot read localStorage, so anything it needs in order
        // to send the queue on its own has to live here beside the queue.
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'k' });
        if (!d.objectStoreNames.contains(LOOKUPS)) d.createObjectStore(LOOKUPS, { keyPath: 'key' });
        // Phone and vehicle corrections, keyed by operative so the newest one wins -
        // there is no value in replaying three changes of mind about a registration.
        if (!d.objectStoreNames.contains(EDITS)) d.createObjectStore(EDITS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(storeName, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    }));
  }

  const outboxPut = (item) => tx(OUTBOX, 'readwrite', (s) => s.put(item));
  const outboxDelete = (id) => tx(OUTBOX, 'readwrite', (s) => s.delete(id));
  const outboxAll = () => tx(OUTBOX, 'readonly', (s) => s.getAll()).then((r) => r || []);
  const metaSet = (k, v) => tx(META, 'readwrite', (s) => s.put({ k, v }));
  const metaGet = (k) => tx(META, 'readonly', (s) => s.get(k)).then((r) => (r ? r.v : null));
  const lookupGet = (key) => tx(LOOKUPS, 'readonly', (s) => s.get(key));
  const lookupPut = (rec) => tx(LOOKUPS, 'readwrite', (s) => s.put(rec));
  const lookupClear = () => tx(LOOKUPS, 'readwrite', (s) => s.clear());
  const editPut = (rec) => tx(EDITS, 'readwrite', (s) => s.put(rec));
  const editDelete = (id) => tx(EDITS, 'readwrite', (s) => s.delete(id));
  const editAll = () => tx(EDITS, 'readonly', (s) => s.getAll()).then((r) => r || []);
  const editClear = () => tx(EDITS, 'readwrite', (s) => s.clear());

  // ------------------------------------------------------------------ crypto

  const hex = (buf) => [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  async function derive(password, saltHex, iterations) {
    const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return hex(crypto.getRandomValues(new Uint8Array(16)));
  }

  /**
   * Re-read the server's address, past every cache between here and the office.
   *
   * config.js is a normal file on a normal web server, which means two caches can
   * answer for it: the service worker's, and the browser's own. Both did. When the
   * address was corrected and published, handsets carried on using the copy they had
   * and said only "Failed to fetch" - for two days, on a one-letter typo.
   *
   * The service worker no longer keeps it. This deals with the other one: a URL with
   * a timestamp on it has never been seen by any cache, so the answer can only have
   * come from the server. It runs in the background at startup, so it costs the crew
   * nothing, and it is deliberately quiet - if the address has not changed, which is
   * almost always, nothing happens at all.
   */
  async function refreshAddress() {
    try {
      const res = await fetch('config.js?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      const m = /API_BASE\s*:\s*['"]([^'"]+)['"]/.exec(text);
      if (!m) return;
      const fresh = m[1].replace(/\/+$/, '');
      if (!fresh || fresh === API) return;

      API = fresh;
      const box = $('login-api');
      if (box) box.textContent = API;
      // Worth saying out loud: somebody at the office has just fixed something, and
      // the crew should know why it started working.
      toast('The office has corrected the server address');
    } catch {
      // No signal. The address already loaded is the best available, which is exactly
      // what the cached copy is for.
    }
  }

  /**
   * fetch, with a failure message somebody could act on.
   *
   * A fetch that never reaches the server rejects with "Failed to fetch" and nothing
   * else - no address, no reason. That single unhelpful string has cost this project
   * an afternoon already: the address in config.js was one letter short, so the name
   * did not resolve, and the phone had no way to say so.
   *
   * Everything this can tell them, it tells them. It cannot tell a wrong address from
   * a Worker that was never deployed - the browser genuinely does not know which -
   * so it names both, and puts the address on the screen to be read back.
   */
  async function reach(path, opts) {
    try {
      return await fetch(API + path, opts);
    } catch (e) {
      if (!navigator.onLine) {
        throw new Error('This phone has no connection at the moment.');
      }
      throw new Error(
        'Could not reach the server at ' + API + ' - so either that address is wrong '
        + 'or nothing is deployed there. Read it back to the office letter by letter; '
        + 'one wrong character looks exactly like this.',
      );
    }
  }

  // ------------------------------------------------------------------ network

  async function api(path, opts) {
    const o = Object.assign({ headers: {} }, opts || {});
    if (token) o.headers.Authorization = 'Bearer ' + token;
    if (o.body) o.headers['Content-Type'] = 'application/json';
    const res = await reach(path, o);
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (res.status === 401) { signOut('Your access was removed. Sign in again.'); throw new Error('Signed out'); }
    // A Worker that throws before it can add its CORS headers never gets this far - the
    // browser rejects it as unreachable instead - so a status with no JSON body is
    // worth naming rather than hiding behind 'Error 500'.
    if (!res.ok) {
      throw new Error((data && data.error)
        || ('The server answered ' + res.status + ' with nothing to explain it.'));
    }
    return data;
  }

  // ------------------------------------------------------------------ next week
  //
  // A plan is not a logon and is not treated as one. It says where a gang expects to
  // be, per day, and the coverage figures never look at it. It asks for less, too: a
  // CMR, a circuit and a work type, with the functional location optional, because a
  // week is planned by circuit rather than by pole.
  //
  // It is filled in with no signal as readily as with it - the CMR list is whatever
  // the phone already has, and the whole week queues like a logon.

  let weekDays = [];        // the dates being planned
  let weekPlan = {};        // date -> what has been entered
  let weekMonday = '';
  let weekLoaded = false;
  // Every CMR on the network, not just the ones on whichever voltage the logon form
  // happens to be set to. The week ahead is planned by CMR and the voltage is never
  // asked for, so the two lists cannot be the same one.
  let weekCmrs = [];

  const dayName = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return DAY_NAMES[new Date(y, m - 1, d, 12).getDay()];
  };

  const isWeekendDay = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const wd = new Date(y, m - 1, d, 12).getDay();
    return wd === 0 || wd === 6;
  };

  async function loadWeek(force) {
    if (weekLoaded && !force) return;
    // Work the dates out here only as a fallback. The server decides which week is
    // "next", because a handset with the wrong date set would otherwise plan the
    // wrong one and nobody would be able to tell.
    const monday = dayOffset(8 - (new Date().getDay() || 7));
    weekMonday = monday;
    weekDays = Array.from({ length: 7 }, (_, i) => {
      const [y, m, d] = monday.split('-').map(Number);
      const t = new Date(y, m - 1, d, 12);
      t.setDate(t.getDate() + i);
      return localDate(t);
    });

    try {
      const [res, cmrs] = await Promise.all([
        api('/api/plan?week=next'),
        api('/api/lookup/cmrs'),
      ]);
      weekMonday = res.monday;
      weekDays = res.days;
      weekCmrs = (cmrs.cmrs || []).map((c) => c.cmr);
      weekPlan = {};
      for (const row of res.plan || []) weekPlan[row.work_date] = row;
      await metaSet('plan', { monday: weekMonday, days: weekDays, plan: weekPlan,
                              cmrs: weekCmrs });
    } catch {
      // No signal. Whatever was last seen is better than an empty week.
      const kept = await metaGet('plan');
      if (kept && kept.monday === weekMonday) {
        weekDays = kept.days;
        weekPlan = kept.plan || {};
        weekCmrs = kept.cmrs || [];
      }
    }
    weekLoaded = true;
    renderWeek();
  }

  function renderWeek() {
    const box = $('week-days');
    const types = lists.work_types.map(typeName).filter(Boolean);
    const cmrs = weekCmrs;

    box.innerHTML = weekDays.map((iso) => {
      const has = weekPlan[iso] || {};
      const filled = !!has.work_type;
      return '<div class="day' + (isWeekendDay(iso) ? ' weekend' : '')
        + (filled ? ' filled' : '') + '" data-day="' + iso + '">'
        + '<h3>' + esc(dayName(iso))
        + ' <span class="date">' + esc(iso.slice(8) + '/' + iso.slice(5, 7)) + '</span></h3>'
        + '<label>Work type</label>'
        + '<select data-f="work_type">' + option('', 'Nothing planned', !has.work_type)
        + types.map((t) => option(t, t, has.work_type === t)).join('') + '</select>'
        + '<label>CMR</label>'
        + '<select data-f="cmr">' + option('', 'Choose...', !has.cmr)
        + cmrs.map((c) => option(c, c, has.cmr === c)).join('')
        + (has.cmr && !cmrs.includes(has.cmr) ? option(has.cmr, has.cmr, true) : '')
        + '</select>'
        + '<label>Circuit</label>'
        + '<input data-f="circuit" list="circuits-' + esc(iso) + '" '
        + 'value="' + esc(has.circuit || '') + '" autocapitalize="characters" '
        + 'autocomplete="off" spellcheck="false">'
        + '<datalist id="circuits-' + esc(iso) + '"></datalist>'
        + '<label>Functional location <span class="date">(optional)</span></label>'
        + '<input data-f="functional_location" value="' + esc(has.functional_location || '')
        + '" autocapitalize="characters" autocomplete="off" spellcheck="false">'
        + '</div>';
    }).join('');

    for (const iso of weekDays) fillCircuits(iso);
    $('week-title').textContent = 'Week beginning ' + inWords(weekMonday);
  }

  const option = (value, label, selected) => '<option value="' + esc(value) + '"'
    + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';

  /** The circuits on whichever CMR that day is set to, offered as suggestions. */
  async function fillCircuits(iso) {
    const card = document.querySelector('[data-day="' + iso + '"]');
    if (!card) return;
    const cmr = card.querySelector('[data-f="cmr"]').value;
    const list = card.querySelector('datalist');
    if (!cmr) { list.innerHTML = ''; return; }
    try {
      const res = await api('/api/lookup/circuits?cmr=' + encodeURIComponent(cmr));
      list.innerHTML = (res.circuits || []).map((c) => '<option value="' + esc(c) + '">').join('');
    } catch {
      list.innerHTML = '';     // no signal; typing still works
    }
  }

  function readWeek() {
    return weekDays.map((iso) => {
      const card = document.querySelector('[data-day="' + iso + '"]');
      const field = (f) => (card.querySelector('[data-f="' + f + '"]') || {}).value || '';
      return {
        work_date: iso,
        work_type: field('work_type'),
        cmr: field('cmr'),
        circuit: field('circuit').trim().toUpperCase(),
        functional_location: field('functional_location').trim().toUpperCase(),
        area: areaForCmr(field('cmr')),
      };
    });
  }

  async function saveWeek() {
    const days = readWeek();
    const planned = days.filter((d) => d.work_type).length;
    try {
      await api('/api/plan', { method: 'POST', body: JSON.stringify({ days }) });
      weekPlan = {};
      for (const d of days) if (d.work_type) weekPlan[d.work_date] = d;
      await metaSet('plan', { monday: weekMonday, days: weekDays, plan: weekPlan });
      $('week-state').textContent = planned
        ? planned + (planned === 1 ? ' day' : ' days') + ' saved. The office can see it.'
        : 'Saved - nothing planned yet.';
      $('week-state').classList.add('saved');
      renderWeek();
    } catch (e) {
      $('week-state').classList.remove('saved');
      $('week-state').textContent = 'Could not save: ' + e.message
        + ' Try again when you have signal - nothing has been lost from the screen.';
    }
  }

  // ------------------------------------------------------------------ reminders
  //
  // If the crew has not logged on by the time the office sets, the handset buzzes.
  //
  // There is no switch for this. It was an opt-in to begin with, on the reasoning that
  // a notification nobody asked for is the fastest way to have every crew turn
  // notifications off for good - but an opt-in that nobody finds is a feature that
  // does not exist, and this one is a safety net rather than a convenience.
  //
  // So it is asked for once, on the first tap after signing in, and never mentioned
  // again. It cannot be asked for without a tap: both Chrome and Safari refuse to show
  // the phone's own "Allow notifications?" prompt unless the person has just done
  // something. That is the browser's rule and there is no way round it.
  //
  // The awkward part is iPhones. Safari only allows any of this once the app has been
  // added to the Home Screen, and there is no way to ask for that on somebody's
  // behalf - so the app says so plainly rather than failing quietly.

  const pushSupported = () => 'serviceWorker' in navigator
    && 'PushManager' in window && 'Notification' in window;

  const onHomeScreen = () => window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;

  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const b64ToBytes = (s2) => {
    const pad = s2.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  /** Say something only when there is something the crew can act on. */
  async function drawRemind() {
    const box = $('remind');
    const state = $('remind-state');
    if (!box) return;

    if (isIOS() && !onHomeScreen()) {
      box.hidden = false;
      state.classList.remove('on');
      state.textContent = 'Add this app to the Home Screen (tap Share, then "Add to '
        + 'Home Screen") and open it from there, or the phone will not be able to '
        + 'remind you if your crew has not logged on.';
      return;
    }

    if (pushSupported() && Notification.permission === 'denied') {
      box.hidden = false;
      state.classList.remove('on');
      state.textContent = 'Notifications are blocked for this app in the phone\'s '
        + 'settings, so it cannot remind you if your crew has not logged on. Only this '
        + 'phone can turn them back on.';
      return;
    }

    // Working as intended, or nothing to be done about it. Either way, silence.
    box.hidden = true;
  }

  /**
   * Ask once, then subscribe. Called from the first tap after sign-in, because the
   * browser will not show its prompt without one.
   */
  let asked = false;
  async function ensureReminders() {
    if (asked || !pushSupported()) return;
    if (isIOS() && !onHomeScreen()) return;
    asked = true;

    try {
      if (Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (Notification.permission !== 'granted') { await drawRemind(); return; }

      // Already subscribed on this handset - nothing to do, and no message either.
      const existing = await currentSub();
      if (existing) {
        await api('/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: existing.endpoint,
                                 label: navigator.platform || 'Phone' }),
        }).catch(() => {});
        await drawRemind();
        return;
      }

      const { key } = await api('/api/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBytes(key),
      });
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: sub.endpoint,
                               label: navigator.platform || 'Phone' }),
      });
    } catch {
      // No signal, or the phone refused. Neither is worth interrupting a crew over;
      // the office can see who is reachable on the Reports tab.
      asked = false;
    }
    await drawRemind();
  }

  // ------------------------------------------------------------------ views

  function show(which) {
    $('view-login').hidden = which !== 'login';
    $('view-main').hidden = which !== 'main';
  }

  let toastTimer = null;
  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text;
    t.className = bad ? 'bad' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android'
      : /iPhone|iPad/.test(ua) ? 'iPhone/iPad'
      : /Windows/.test(ua) ? 'Windows' : 'Other';
    const br = /EdgA?\//.test(ua) ? 'Edge'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    return os + ' / ' + br;
  }

  // ------------------------------------------------------------------ sign in

  // Put the address on the screen at startup. It is collapsed, so it costs a crew
  // nothing, and it is there the moment anybody asks "which server is it using?" -
  // a question that previously had no answer short of reading files on the phone.
  refreshAddress();

  (function showWhere() {
    const api = $('login-api');
    if (api) api.textContent = API || '(no address set at all)';
    const build = $('login-build');
    if (build) build.textContent = 'App version ' + APP_VERSION + '.';
  }());

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim();
    const password = $('password').value;
    const btn = $('login-go');
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    $('login-msg').innerHTML = '';
    try {
      if (!API || /YOURNAME/.test(API)) {
        throw new Error('This app has not been pointed at its server yet (config.js).');
      }
      const begin = await reach('/api/auth/begin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }).then((r) => r.json());

      // Deliberately slow - roughly a third of a second on a modern phone. That cost
      // is what makes the stored value expensive to attack.
      const dk = await derive(password, begin.salt, begin.iterations);

      const res = await reach('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, dk, label: deviceLabel() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign in failed');

      token = data.token;
      user = data.user;
      store.set(KEY_TOKEN, token);
      store.set(KEY_USER, user);
      $('password').value = '';
      await afterSignIn();
    } catch (err) {
      $('login-msg').innerHTML = '<div class="msg err">' + esc(err.message) + '</div>';
      // A failure is exactly when the address matters, so stop hiding it.
      const where = $('login-where');
      if (where) where.open = true;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  function signOut(why) {
    store.del(KEY_TOKEN); store.del(KEY_USER); store.del(KEY_LISTS);
    token = ''; user = null;
    lists = { operatives: [], work_types: [], voltages: [], lookup_version: '0' };
    weekLoaded = false;
    weekPlan = {};
    metaSet('auth', { token: '', api: API }).catch(() => {});
    show('login');
    if (why) $('login-msg').innerHTML = '<div class="msg err">' + esc(why) + '</div>';
  }

  $('signout').addEventListener('click', async () => {
    const [pending, edits] = await Promise.all([outboxAll(), editAll()]);
    const waiting = pending.length + edits.length;
    if (waiting && !confirm(
      waiting + ' thing(s) have not reached the office yet. Signing out will lose them. Continue?')) return;
    if (!confirm('Sign out? You will need the email and password again to use this phone.')) return;
    try { await api('/api/logout', { method: 'POST' }); } catch { /* offline is fine */ }
    await Promise.all([lookupClear().catch(() => {}), editClear().catch(() => {})]);
    signOut();
  });

  // ------------------------------------------------------------------ crew + lists

  async function refreshLists(quiet) {
    try {
      const d = await api('/api/bootstrap');
      const staleLookup = d.lookup_version !== lists.lookup_version;
      user = d.user;

      // A correction made here but not yet sent must survive the server's answer,
      // otherwise the crew watch their own edit disappear the moment signal returns.
      const pending = new Map((await editAll()).map((e) => [String(e.id), e]));
      for (const o of d.operatives) {
        const mine = pending.get(String(o.id));
        if (mine) { o.phone = mine.phone; o.vehicle_reg = mine.vehicle_reg; }
      }

      lists = {
        operatives: d.operatives, work_types: d.work_types,
        voltages: d.voltages, lookup_version: d.lookup_version,
      };
      store.set(KEY_USER, user);
      store.set(KEY_LISTS, lists);

      // The office republished the network data, so everything cached here is out of
      // date. Throw it away rather than showing a location that no longer exists.
      if (staleLookup) {
        await lookupClear().catch(() => {});
        if (!quiet) toast('Network lists have been updated');
      }

      renderCrew();
      renderVoltages();
      renderWorkTypes();
      if (!quiet) toast('Lists updated');
    } catch {
      if (!quiet) toast('Could not update lists - using the last copy', true);
    }
  }

  /** "Cutter, Machine Operator · 07700 900123 · AB12 CDE" - whatever of it exists. */
  function crewSubtitle(o) {
    const roles = (o.roles || '').split(',').filter(Boolean).join(', ');
    return [roles, o.phone, o.vehicle_reg].filter(Boolean).join(' · ');
  }

  /**
   * Someone who holds only surveyor and/or manager works on their own, so they cannot
   * share a logon. The server decides this and sends it down as `lone`, so there is
   * one definition rather than two that can drift apart.
   */
  const isLone = (o) => !!(o && o.lone);

  function operativeById(id) {
    return lists.operatives.find((o) => String(o.id) === String(id));
  }

  /**
   * Keep a lone worker on their own, without ever refusing a tap.
   *
   * Blocking the tick would leave a crew poking at a checkbox that will not move with
   * no idea why. Swapping the selection and saying what happened does the same job and
   * is obvious.
   */
  function enforceLoneWorking(changed) {
    const boxes = [...document.querySelectorAll('#people input[type="checkbox"]')];
    const ticked = boxes.filter((b) => b.checked);
    if (!changed.checked || ticked.length < 2) return;

    const changedOp = operativeById(changed.value);
    const others = ticked.filter((b) => b !== changed);

    if (isLone(changedOp)) {
      for (const b of others) b.checked = false;
      toast(changedOp.name + ' works alone, so the others have been unticked');
      renderCrew();
      return;
    }

    const loneOthers = others.filter((b) => isLone(operativeById(b.value)));
    if (loneOthers.length) {
      for (const b of loneOthers) b.checked = false;
      const names = loneOthers.map((b) => b.dataset.name).join(' and ');
      toast(names + ' works alone, so they have been unticked');
      renderCrew();
    }
  }

  function renderCrew() {
    $('hdr-name').textContent = user ? user.name : '';
    $('hdr-company').textContent = user && user.company ? user.company : '';

    const picked = new Set([...document.querySelectorAll('#people input[type="checkbox"]:checked')]
      .map((i) => i.value));

    const rows = lists.operatives.map((o) => {
      const sub = crewSubtitle(o);
      return '<div class="person' + (isLone(o) ? ' lone' : '') + '" data-id="' + o.id + '">' +
        '<label><input type="checkbox" value="' + o.id + '" data-name="' + esc(o.name) + '"' +
        (picked.has(String(o.id)) ? ' checked' : '') + '>' +
        '<span class="who"><span class="nm">' + esc(o.name) + '</span>' +
        '<span class="sub' + (sub ? '' : ' none') + '">' +
        (isLone(o) ? '<b>Works alone</b>' + (sub ? ' \u00b7 ' : '') : '') +
        (sub ? esc(sub) : (isLone(o) ? '' : 'No phone or vehicle yet')) + '</span>' +
        '</span></label>' +
        '<button type="button" class="edit" data-edit="' + o.id + '" ' +
        'aria-label="Edit phone and vehicle for ' + esc(o.name) + '">Edit</button></div>';
    }).join('');

    const extras = extraPeople.map((n, i) =>
      '<div class="person"><label><input type="checkbox" value="x' + i +
      '" data-name="' + esc(n) + '" checked>' +
      '<span class="who"><span class="nm">' + esc(n) + '</span>' +
      '<span class="sub none">Not on the roster</span></span></label></div>').join('');

    $('people').innerHTML = rows + extras ||
      '<p class="hint">No operatives listed for your account yet - ask the office to add them.</p>';
  }

  /**
   * Correcting a phone or a vehicle from the field.
   *
   * This is not a note on today's logon - it changes that operative's details for
   * good, which is what the office wants: the van someone is in today is the van they
   * are in until it changes again.
   */
  function openEditor(id) {
    for (const old of document.querySelectorAll('.editor')) old.remove();
    const op = lists.operatives.find((o) => String(o.id) === String(id));
    if (!op) return;
    const row = document.querySelector('.person[data-id="' + id + '"]');
    if (!row) return;

    const box = document.createElement('div');
    box.className = 'editor';
    box.innerHTML =
      '<label for="ed-phone">Phone for ' + esc(op.name) + '</label>' +
      '<input id="ed-phone" type="tel" inputmode="tel" autocomplete="off" value="' +
        esc(op.phone || '') + '">' +
      '<label for="ed-reg">Vehicle registration</label>' +
      '<input id="ed-reg" autocapitalize="characters" autocomplete="off" spellcheck="false" ' +
        'value="' + esc(op.vehicle_reg || '') + '">' +
      '<p class="hint">This becomes their details from now on, not just for today.</p>' +
      '<div class="editor-buttons">' +
        '<button type="button" class="link" id="ed-cancel">Cancel</button>' +
        '<button type="button" class="small" id="ed-save">Save</button>' +
      '</div>';
    row.after(box);
    $('ed-phone').focus();

    $('ed-cancel').onclick = () => box.remove();
    $('ed-save').onclick = async () => {
      const phone = $('ed-phone').value.trim();
      const reg = $('ed-reg').value.trim().toUpperCase();
      box.remove();

      // Show it immediately and keep it across a restart, whether or not it has
      // reached the office yet.
      op.phone = phone;
      op.vehicle_reg = reg;
      store.set(KEY_LISTS, lists);
      renderCrew();

      await editPut({ id: op.id, phone, vehicle_reg: reg });
      await flushEdits();
      await drawOutbox();
      askBackgroundSync();
    };
  }

  $('people').addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') enforceLoneWorking(e.target);
  });

  $('people').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-edit]');
    if (b) openEditor(b.dataset.edit);
  });

  /**
   * A work type is an object now - a name, and sometimes a list of options the crew
   * must choose from once they have picked it. Older phones stored plain strings, and
   * a phone that has not refreshed since the update still has them, so both shapes
   * have to read the same way here.
   */
  const typeName = (w) => (typeof w === 'string' ? w : (w && w.name) || '');
  const typeFor = (name) => lists.work_types
    .map((w) => (typeof w === 'string' ? { name: w, options: [] } : w))
    .find((w) => w.name === name) || null;

  function renderWorkTypes() {
    const wt = $('work-type');
    const keep = wt.value;
    wt.innerHTML = '<option value="">Choose...</option>' +
      lists.work_types.map((w) => '<option>' + esc(typeName(w)) + '</option>').join('');
    if (keep) wt.value = keep;
    renderWorkDetail();
  }

  /**
   * The second dropdown: Live or Shutdown on cutting, and whatever the office adds
   * later on anything else. Hidden entirely when the chosen work type has no options,
   * which is most of them.
   */
  function renderWorkDetail() {
    const wrap = $('detail-wrap');
    const sel = $('work-detail');
    const type = typeFor($('work-type').value);
    const options = (type && type.options) || [];

    if (!options.length) {
      wrap.hidden = true;
      sel.innerHTML = '';
      $('detail-hint').textContent = '';
      $('detail-hint').classList.remove('warn');
      return;
    }

    const keep = sel.value;
    wrap.hidden = false;
    $('detail-label').textContent = options.join(' or ');
    sel.innerHTML = '<option value="">Choose...</option>' +
      options.map((o) => '<option>' + esc(o) + '</option>').join('');
    if (keep && options.includes(keep)) sel.value = keep;
    drawDetailHint();
  }

  function drawDetailHint() {
    const type = typeFor($('work-type').value);
    const hint = $('detail-hint');
    const chosen = $('work-detail').value;
    const warns = !!(type && type.warn_option && chosen
                     && chosen.toLowerCase() === type.warn_option.toLowerCase());
    hint.textContent = warns ? (type.warn_text || '') : '';
    hint.classList.toggle('warn', warns);
  }

  /**
   * Hold the crew up until they have acknowledged something.
   *
   * A toast would slide away whether or not anybody read it. This one has to be
   * tapped, because the whole reason it exists is to be sure somebody saw it before
   * they went on to a live circuit.
   */
  function insist(text) {
    return new Promise((resolve) => {
      $('remind-text').textContent = text;
      $('remind-overlay').hidden = false;
      const ok = $('remind-ok');
      const done = () => {
        ok.removeEventListener('click', done);
        $('remind-overlay').hidden = true;
        resolve();
      };
      ok.addEventListener('click', done);
      ok.focus();
    });
  }

  // ------------------------------------------------------------------ the cascade

  function renderVoltages() {
    const sel = $('voltage');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Choose...</option>' +
      lists.voltages.map((v) => '<option>' + esc(v) + '</option>').join('');
    if (keep && lists.voltages.includes(keep)) sel.value = keep;
  }

  function setCmrs(rows) {
    cmrsForVoltage = rows;
    const sel = $('cmr');
    sel.innerHTML = '<option value="">Choose...</option>' +
      rows.map((r) => '<option value="' + esc(r.cmr) + '">' + esc(r.cmr) +
        (r.area ? ' - ' + esc(r.area) : '') + '</option>').join('');
    sel.disabled = !rows.length;
  }

  function resetFl() {
    chosenFl = null;
    locations = [];
    $('fl').value = '';
    $('fl').disabled = true;
    $('fl-matches').hidden = true;
    $('fl-hint').textContent = '';
    $('area').value = '';
  }

  $('voltage').addEventListener('change', async () => {
    const v = $('voltage').value;
    setCmrs([]);
    resetFl();
    $('cmr-hint').textContent = '';
    if (!v) return;

    const key = 'cmrs|' + v;
    const cached = await lookupGet(key).catch(() => null);
    if (cached && cached.version === lists.lookup_version) setCmrs(cached.rows);

    if (navigator.onLine) {
      try {
        const d = await api('/api/lookup/cmrs?voltage=' + encodeURIComponent(v));
        setCmrs(d.cmrs);
        await lookupPut({ key, version: lists.lookup_version, rows: d.cmrs });
      } catch {
        if (!cached) $('cmr-hint').textContent = 'Could not fetch the CMRs for that voltage.';
      }
    } else if (!cached) {
      $('cmr-hint').textContent = 'No signal and this voltage has not been used on this phone before.';
    }
  });

  $('cmr').addEventListener('change', async () => {
    const v = $('voltage').value;
    const c = $('cmr').value;
    resetFl();
    if (!c) return;

    const key = 'fls|' + v + '|' + c;
    const cached = await lookupGet(key).catch(() => null);
    if (cached && cached.version === lists.lookup_version) {
      locations = cached.rows;
      $('fl').disabled = false;
      $('fl-hint').textContent = locations.length + ' locations on this CMR, held on this phone.';
    }

    if (navigator.onLine) {
      try {
        $('fl-hint').textContent = 'Fetching locations...';
        const d = await api('/api/lookup/locations?voltage=' + encodeURIComponent(v) +
          '&cmr=' + encodeURIComponent(c));
        locations = d.locations;
        $('fl').disabled = false;
        await lookupPut({ key, version: lists.lookup_version, rows: locations });
        $('fl-hint').textContent = locations.length +
          ' locations on this CMR, now saved on this phone for when you have no signal.';
      } catch {
        $('fl-hint').textContent = cached
          ? locations.length + ' locations on this CMR, held on this phone.'
          : 'Could not fetch the locations for that CMR.';
      }
    } else if (!cached) {
      $('fl-hint').textContent = 'No signal, and this CMR has not been used on this phone before. ' +
        'Type the location in full.';
      $('fl').disabled = false;   // let them type it rather than blocking the logon
    }
  });

  function renderMatches() {
    const q = $('fl').value.trim().toUpperCase();
    const box = $('fl-matches');
    if (!q || chosenFl === q) { box.hidden = true; return; }

    const hits = locations.filter((l) => l.fl.toUpperCase().includes(q)).slice(0, MAX_MATCHES);
    box.hidden = false;
    if (!hits.length) {
      box.innerHTML = '<div class="none">No match' +
        (locations.length ? '. Check the CMR, or leave it typed as it is.' : '') + '</div>';
      return;
    }
    box.innerHTML = hits.map((l) =>
      '<button type="button" data-fl="' + esc(l.fl) + '" data-area="' + esc(l.area || '') + '">' +
      esc(l.fl) + (l.area ? '<br><span class="when">' + esc(l.area) + '</span>' : '') +
      '</button>').join('');
  }

  $('fl').addEventListener('input', () => {
    chosenFl = null;
    $('area').value = '';
    renderMatches();
  });

  $('fl-matches').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fl]');
    if (!b) return;
    chosenFl = b.dataset.fl;
    $('fl').value = b.dataset.fl;
    $('area').value = b.dataset.area || areaForCmr();
    $('fl-matches').hidden = true;
  });

  /** Which circuit a functional location sits on, if the lookup knows. */
  function circuitForFl(fl) {
    const hit = locations.find((l) => l.fl === fl);
    return (hit && hit.circuit) || '';
  }

  function areaForCmr(which) {
    const cmr = which === undefined ? $('cmr').value : which;
    const hit = cmrsForVoltage.find((r) => r.cmr === cmr);
    return hit && hit.area ? hit.area : '';
  }

  // The first tap anywhere in the form is what lets the browser show its own prompt.
  // Once is enough - ensureReminders() does nothing on every tap after it.
  $('view-main').addEventListener('pointerdown', () => { ensureReminders(); },
    { once: true });

  // --- the two halves of the screen ---------------------------------------
  function showTab(which) {
    const week = which === 'week';
    $('tab-today').setAttribute('aria-pressed', String(!week));
    $('tab-week').setAttribute('aria-pressed', String(week));
    $('logon-form').hidden = week;
    $('outbox').hidden = week || !$('outbox').textContent;
    $('recent').hidden = week;
    // The reminders note belongs with the day's work, not with next week's plan.
    $('remind').hidden = week || !$('remind-state').textContent;
    $('week').hidden = !week;
    if (week) loadWeek(false);
  }

  $('tab-today').addEventListener('click', () => showTab('today'));
  $('tab-week').addEventListener('click', () => showTab('week'));
  $('week-save').addEventListener('click', saveWeek);

  // A day's circuit list follows that day's CMR.
  $('week-days').addEventListener('change', (e) => {
    const card = e.target.closest('[data-day]');
    if (!card) return;
    if (e.target.dataset.f === 'cmr') fillCircuits(card.dataset.day);
    card.classList.toggle('filled',
      !!card.querySelector('[data-f="work_type"]').value);
  });

  $('work-type').addEventListener('change', renderWorkDetail);
  $('work-detail').addEventListener('change', async () => {
    drawDetailHint();
    const type = typeFor($('work-type').value);
    const chosen = $('work-detail').value;
    if (type && type.warn_option && chosen
        && chosen.toLowerCase() === type.warn_option.toLowerCase()) {
      await insist(type.warn_text
        || 'Remember to log on with control as well.');
    }
  });

  $('day-today').addEventListener('click', () => setDay(dayOffset(0)));
  $('day-tomorrow').addEventListener('click', () => setDay(dayOffset(1)));
  $('work-date').addEventListener('change', drawDay);

  $('add-other').addEventListener('click', () => {
    const n = prompt('Name of the person on site:');
    if (n && n.trim()) { extraPeople.push(n.trim()); renderCrew(); }
  });

  $('refresh').addEventListener('click', () => refreshLists(false));

  // ------------------------------------------------------------------ sending

  $('logon-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const people = [...document.querySelectorAll('#people input:checked')].map((i) => ({
      id: /^\d+$/.test(i.value) ? Number(i.value) : null,
      name: i.dataset.name,
    }));
    if (!people.length) { toast('Tick at least one person', true); return; }
    if (!$('work-type').value) { toast('Choose a work type', true); return; }

    const chosenType = typeFor($('work-type').value);
    const needsDetail = !!(chosenType && (chosenType.options || []).length);
    if (needsDetail && !$('work-detail').value) {
      toast('Choose ' + (chosenType.options || []).join(' or '), true);
      return;
    }

    const chosen = $('work-date').value;
    if (!chosen) { toast('Pick the day this is for', true); return; }
    if (chosen > dayOffset(1)) {
      toast('You can only log on for today or tomorrow', true);
      return;
    }

    const item = {
      id: uuid(),
      work_date: $('work-date').value,
      voltage: $('voltage').value,
      cmr: $('cmr').value,
      functional_location: $('fl').value.trim().toUpperCase(),
      area: $('area').value || areaForCmr(),
      // Taken from the location rather than asked for. A logon is already long enough,
      // and the board wants the circuit so a day's work can be lined up against the
      // week that was planned for it.
      circuit: circuitForFl($('fl').value.trim().toUpperCase()),
      work_type: $('work-type').value,
      work_detail: needsDetail ? $('work-detail').value : '',
      notes: $('notes').value.trim(),
      people,
      created_at: new Date().toISOString(),
    };

    await outboxPut(item);

    $('notes').value = '';
    extraPeople = [];
    for (const cb of document.querySelectorAll('#people input:checked')) cb.checked = false;
    renderCrew();

    await flush();
    await drawOutbox();
    askBackgroundSync();
  });

  /** Send any phone/vehicle corrections. Quiet on success - nobody needs a toast. */
  async function flushEdits() {
    if (!token || !navigator.onLine) return;
    for (const e of await editAll()) {
      try {
        await api('/api/operatives/' + e.id + '/contact', {
          method: 'POST',
          body: JSON.stringify({ phone: e.phone, vehicle_reg: e.vehicle_reg }),
        });
        await editDelete(e.id);
      } catch (err) {
        if (/Signed out/.test(err.message)) return;
        // A 403 means the office has moved that person off this crew, so replaying it
        // will never work. Anything else is worth another go later.
        if (/not on your crew/.test(err.message)) await editDelete(e.id);
        else break;
      }
    }
  }

  let flushing = false;

  /** Try to empty the queue. Safe to call as often as you like. */
  async function flush() {
    if (flushing || !token) return;
    flushing = true;
    try {
      await flushEdits();
      const items = await outboxAll();
      if (!items.length) return;
      if (!navigator.onLine) { toast('Saved on this phone - it will send when you have signal'); return; }

      let sent = 0;
      for (const item of items) {
        try {
          const res = await api('/api/submit', { method: 'POST', body: JSON.stringify(item) });
          // 'duplicate' means the server already had it - equally good, remove it.
          if (res && (res.status === 'stored' || res.status === 'duplicate')) {
            await outboxDelete(item.id);
            sent++;
          }
        } catch (err) {
          if (/Signed out/.test(err.message)) return;
          break;   // network trouble; leave the rest for next time
        }
      }
      if (sent) {
        toast(sent === 1 ? 'Logon sent' : sent + ' logons sent');
        loadRecent();
      }
    } finally {
      flushing = false;
      drawOutbox();
    }
  }

  async function drawOutbox() {
    const [items, edits] = await Promise.all([outboxAll(), editAll()]);
    const box = $('outbox');
    if (!items.length && !edits.length) { box.hidden = true; return; }
    box.hidden = false;

    const parts = [];
    if (items.length) parts.push(items.length + (items.length === 1 ? ' logon' : ' logons'));
    if (edits.length) parts.push(edits.length + (edits.length === 1 ? ' change' : ' changes')
      + ' to phone or vehicle');

    box.innerHTML = '<strong>' + parts.join(' and ') + ' waiting to send.</strong> ' +
      'Saved on this phone and will go automatically when you have signal. ' +
      '<button class="link" id="retry">Try now</button>';
    $('retry').onclick = () => flush();
  }

  function askBackgroundSync() {
    // Chrome/Android only. Where it works, the phone sends the queue even if the app
    // has been closed. Everywhere else the flush on next open does the job.
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready
        .then((reg) => reg.sync.register('flush-outbox'))
        .catch(() => { /* not available, no matter */ });
    }
  }

  async function loadRecent() {
    try {
      const d = await api('/api/mine');
      $('recent-list').innerHTML = (d.submissions || []).slice(0, 8).map((s) =>
        '<li><strong>' + esc(s.work_date) + '</strong> &middot; ' + esc(s.work_type || '') +
        '<div class="when">' + esc([s.cmr, s.functional_location].filter(Boolean).join(' / ')) +
        ' &middot; ' + s.people_count + ' on site</div></li>').join('') ||
        '<li class="when">Nothing sent yet.</li>';
    } catch { /* offline - leave whatever is on screen */ }
  }

  // ------------------------------------------------------------------ status

  function drawNet() {
    const n = $('net');
    if (navigator.onLine) { n.hidden = true; return; }
    n.hidden = false;
    n.className = 'banner';
    n.textContent = 'No signal. You can still fill in and send - it will queue on this phone.';
  }

  window.addEventListener('online', () => { drawNet(); flush(); });
  window.addEventListener('offline', drawNet);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });

  // ------------------------------------------------------------------ start

  async function afterSignIn() {
    show('main');
    await metaSet('auth', { token, api: API });
    // The picker itself stops at tomorrow. The check below the form repeats it, because
    // a date typed straight into the box gets past the picker on some Androids.
    $('work-date').max = dayOffset(1);
    $('work-date').min = dayOffset(-31);
    setDay(openingDay());
    $('ver').textContent = 'v' + APP_VERSION;
    renderCrew();
    renderVoltages();
    renderWorkTypes();
    resetFl();
    drawNet();
    await drawOutbox();
    drawRemind().catch(() => {});
    weekLoaded = false;
    showTab('today');
    refreshLists(true);
    loadRecent();
    flush();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* still works without it */ });
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data === 'flush-outbox') flush();
    });
  }

  if (token && user) afterSignIn(); else show('login');
})();
