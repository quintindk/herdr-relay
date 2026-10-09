import { RelayError, requireValue } from './protocol.mjs';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const FIELDS = [[0, 59, 'minute'], [0, 23, 'hour'], [1, 31, 'day of month'],
  [1, 12, 'month'], [0, 6, 'day of week']];

/** Preview Paperclip's numeric cron semantics without creating a schedule. */
export function previewCron(cron, timezone = 'Africa/Johannesburg', now = Date.now()) {
  requireValue(typeof cron === 'string' && cron.length <= 65536 && cron.trim().split(/\s+/).length === 5,
    'invalid_cron', 'Cron must contain exactly five numeric fields: minute hour day-of-month month day-of-week');
  cron = cron.trim().split(/\s+/).join(' ');
  const [minutes, hours, days, months, weekdays] = cron.split(' ').map((field, index) => {
    const [min, max, name] = FIELDS[index];
    const values = new Set();
    for (const item of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      requireValue(match, 'invalid_cron', `Invalid cron ${name} element: ${item}`);
      const [, base, stride] = match;
      const step = stride === undefined ? 1 : Number(stride);
      requireValue(Number.isSafeInteger(step) && step > 0, 'invalid_cron', `Invalid cron ${name} step`);
      const [start, end] = base === '*' ? [min, max] : base.includes('-') ? base.split('-').map(Number)
        : [Number(base), stride === undefined ? Number(base) : max];
      requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= min && end <= max && start <= end,
        'invalid_cron', `Invalid cron ${name} range: expected ${min}-${max} with start <= end`);
      for (let value = start; value <= end; value += step) values.add(value);
    }
    return [...values].sort((a, b) => a - b);
  });

  requireValue(typeof timezone === 'string' && (timezone === 'UTC' ||
    /^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/.test(timezone)),
  'invalid_timezone', 'Timezone must be an explicit IANA name such as Africa/Johannesburg, or UTC');
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn',
      era: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  } catch {
    throw new RelayError('invalid_timezone', `Invalid IANA timezone: ${timezone}`, 400);
  }
  // Paperclip searches 5 * 366 days from the next UTC minute, not five calendar anniversaries.
  requireValue(typeof now === 'number' && Number.isFinite(now) && Number.isFinite(new Date(now).getTime()),
    'invalid_now', 'now must be a finite epoch-millisecond timestamp');
  const first = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  const limit = first + 5 * 366 * DAY;
  requireValue(Number.isFinite(new Date(limit + 3 * DAY).getTime()) && Number.isFinite(new Date(first - 2 * DAY).getTime()),
  'invalid_now', 'now must be a finite epoch-millisecond timestamp with room for the five-year preview');

  function localMinute(instant) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    const date = new Date(0);
    date.setUTCFullYear(parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    date.setUTCHours(Number(parts.hour), Number(parts.minute), 0, 0);
    return date.getTime();
  }

  let runs = [];
  // Nominal local dates are UTC calendar values. Padding covers every IANA offset,
  // including date-line changes. Do not stop at three until later dates cannot precede them.
  for (let day = Math.floor(first / DAY) * DAY - DAY; day < limit + DAY; day += DAY) {
    if (runs.length === 3 && day - DAY >= runs[2]) break;
    const date = new Date(day);
    if (!months.includes(date.getUTCMonth() + 1) || !days.includes(date.getUTCDate()) || !weekdays.includes(date.getUTCDay())) continue;

    // Hourly probes around matching dates capture both sides of IANA transitions,
    // including half-hour DST and whole-day jumps. No Intl work on skipped dates.
    const offsets = new Set();
    for (let probe = day - DAY; probe <= day + 2 * DAY; probe += 60 * MINUTE) {
      offsets.add(localMinute(probe) - probe);
    }
    for (const offset of offsets) {
      let found = 0;
      candidates: for (const hour of hours) {
        for (const minute of minutes) {
          const local = day + (hour * 60 + minute) * MINUTE;
          const instant = local - offset;
          if (instant < first || instant >= limit) continue;
          // Round-trip rejects nonexistent wall times and retains both UTC instants
          // for a repeated wall minute. Historical sub-minute offsets match UTC ticks too.
          if (localMinute(instant) !== local) continue;
          runs.push(instant);
          if (++found === 3) break candidates;
        }
      }
    }
    runs = [...new Set(runs)].sort((a, b) => a - b).slice(0, 3);
  }
  requireValue(runs.length > 0, 'invalid_cron', 'Cron has no matching run within the five-year preview horizon');
  const warnings = [
    'Five-field numeric cron uses AND matching for day-of-month and day-of-week; Sunday is 0, not 7.',
    'DST and timezone changes: nonexistent local times are skipped; repeated local times run at both matching UTC instants.',
  ];
  if (runs.length < 3) warnings.push('The five-year (1,830-day) preview horizon ended before three runs were found.');
  return { cron, timezone, nextRuns: runs.map(instant => new Date(instant).toISOString()), warnings,
    ...(runs.length < 3 ? { horizonEnded: true } : {}) };
}
