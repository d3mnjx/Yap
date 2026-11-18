// Times in the account's zone, with the date order and the clock style from Settings (MR-05, MR-06, ST-19,
// ST-20). The stored format is "dmy-24h" or "dmy-24h-cs-CZ" (order, clock, optional culture), the same
// grammar as LocaleResolver on the server. Until the account chooses, the browser language decides.

let prefs = { order: 'dmy', clock: '24h', locale: undefined, timeZone: undefined };
let cache = new Map();   // Intl formatters by key; rebuilt when the preferences change

// Called from the store's 'user' listener in main.js with { dateFormat, locale, timeZone }.
export function usePreferences({ dateFormat, locale, timeZone } = {}) {
  const [order, clock, ...culture] = (dateFormat ?? '').split('-');
  const valid = ['dmy', 'mdy', 'ymd'].includes(order) && ['24h', '12h'].includes(clock);
  const guessLocale = culture.length ? culture.join('-') : locale || navigator.language;
  prefs = {
    order: valid ? order : guessOrder(guessLocale),
    clock: valid ? clock : guessClock(guessLocale),
    locale: safeLocale(guessLocale),
    timeZone: safeZone(timeZone),
  };
  cache = new Map();
}

function safeLocale(locale) {
  try { return Intl.DateTimeFormat.supportedLocalesOf([locale])[0]; } catch { return undefined; }
}

// IANA names pass through. A fixed offset chosen in Settings arrives as "UTC+1" or "GMT-5:30" (ST-19);
// Intl takes it as "+01:00". Anything the browser rejects falls back to the browser's zone.
function safeZone(zone) {
  if (!zone) return undefined;
  let candidate = zone;
  const m = /^(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(zone);
  if (m) candidate = `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`;
  else if (/^(?:UTC|GMT)$/i.test(zone)) candidate = 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: candidate }); return candidate; } catch { return undefined; }
}

function guessOrder(locale) {
  try {
    const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(new Date(2000, 11, 31));
    const order = parts.filter(p => ['day', 'month', 'year'].includes(p.type)).map(p => p.type[0]).join('');
    return ['dmy', 'mdy', 'ymd'].includes(order) ? order : 'dmy';
  } catch { return 'dmy'; }
}

function guessClock(locale) {
  try { return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 ? '12h' : '24h'; }
  catch { return '24h'; }
}

function formatter(key, options) {
  let f = cache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(prefs.locale, { timeZone: prefs.timeZone, ...options }); cache.set(key, f); }
  return f;
}

export function timeOf(date) {
  const f = formatter('time', prefs.clock === '12h' ? { hour: 'numeric', minute: '2-digit', hour12: true } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(date);
}

// The server's patterns were dd/MM, M/d and MM-dd (with the year: dd/MM/yyyy, M/d/yyyy, yyyy-MM-dd), where
// "/" is the culture's separator. ymd is ISO with a fixed "-".
function dateOf(date, withYear) {
  if (prefs.order === 'ymd') {
    const p = partsOf(date);
    return withYear ? `${p.year}-${p.month}-${p.day}` : `${p.month}-${p.day}`;
  }
  const twoDigit = prefs.order === 'dmy';
  const p = partsOf(date, twoDigit);
  const first = prefs.order === 'dmy' ? p.day : p.month;
  const second = prefs.order === 'dmy' ? p.month : p.day;
  const base = `${first}${p.separator}${second}`;
  return withYear ? `${base}${p.separator}${p.year}` : base;
}

function partsOf(date, twoDigit = true) {
  const f = formatter(`date-${twoDigit}`, { day: twoDigit ? '2-digit' : 'numeric', month: twoDigit ? '2-digit' : 'numeric', year: 'numeric' });
  const out = { separator: '/' };
  for (const part of f.formatToParts(date)) {
    if (part.type === 'literal' && !/^\s*$/.test(part.value) && out.separator === '/') out.separator = part.value.trim() || '/';
    else if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

// "today" and "yesterday" in the account's zone: compare calendar days, not 24 h spans (MR-05). The result is the
// count of calendar days from 1970 to the date's day in that zone, so today minus yesterday is always 1. "now minus
// 24 hours" was here before, and it gave the wrong day for one hour after a clock change, when a day has 23 or 25 hours.
// The Gregorian calendar and Latin digits are fixed, whatever the locale: these parts go into arithmetic, not onto
// the screen.
function dayNumber(date) {
  const f = formatter('day-number', { day: 'numeric', month: 'numeric', year: 'numeric', calendar: 'gregory', numberingSystem: 'latn' });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = +part.value;
  return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
}

// MR-05: today → time; yesterday → "Yesterday {time}"; this year → date and time; older → full date and time.
export function messageTime(iso, now = new Date()) {
  const date = new Date(iso);
  const time = timeOf(date);
  const daysBack = dayNumber(now) - dayNumber(date);
  if (daysBack === 0) return time;
  if (daysBack === 1) return `Yesterday ${time}`;
  return `${dateOf(date, partsOf(date).year !== partsOf(now).year)} ${time}`;
}

// Elapsed time in words for the admin tables and the device list ("3 min ago").
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
