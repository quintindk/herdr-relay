import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewCron } from '../src/cron-schedule.mjs';

const at = value => Date.parse(value);

test('default timezone, normalised fields, weekday mornings and semantic warnings', () => {
  const result = previewCron('  0\t8  * * 1-5\n', undefined, at('2026-10-09T06:00:00Z'));
  assert.equal(result.cron, '0 8 * * 1-5');
  assert.equal(result.timezone, 'Africa/Johannesburg');
  assert.deepEqual(result.nextRuns, ['2026-10-12T06:00:00.000Z', '2026-10-13T06:00:00.000Z', '2026-10-14T06:00:00.000Z']);
  assert.equal(result.horizonEnded, undefined);
  assert.ok(result.warnings.some(warning => /AND.*Sunday is 0/.test(warning)));
  assert.ok(result.warnings.some(warning => /nonexistent.*skipped.*repeated.*both/.test(warning)));
});

test('strictly after now, UTC whole-minute alignment, and the default real clock', t => {
  for (const now of ['2026-10-08T12:00:00Z', '2026-10-08T12:00:59.999Z']) {
    assert.deepEqual(previewCron('* * * * *', 'UTC', at(now)).nextRuns,
      ['2026-10-08T12:01:00.000Z', '2026-10-08T12:02:00.000Z', '2026-10-08T12:03:00.000Z']);
  }
  t.mock.method(Date, 'now', () => at('2026-10-08T12:00:00Z'));
  assert.equal(previewCron('* * * * *').nextRuns[0], '2026-10-08T12:01:00.000Z');
  assert.equal(previewCron('* * * * *', 'UTC', -1).nextRuns[0], '1970-01-01T00:00:00.000Z');
});

test('numeric steps, stepped ranges, wildcard steps and mixed duplicate lists', () => {
  const now = at('2026-01-01T00:00:00Z');
  assert.deepEqual(previewCron('5/20 0 * * *', 'UTC', now).nextRuns,
    ['2026-01-01T00:05:00.000Z', '2026-01-01T00:25:00.000Z', '2026-01-01T00:45:00.000Z']);
  assert.deepEqual(previewCron('9,1-7/3,4,*/30 0 * * *', 'UTC', now).nextRuns,
    ['2026-01-01T00:01:00.000Z', '2026-01-01T00:04:00.000Z', '2026-01-01T00:07:00.000Z']);
  assert.deepEqual(previewCron('0 22/1 * * *', 'UTC', now).nextRuns,
    ['2026-01-01T22:00:00.000Z', '2026-01-01T23:00:00.000Z', '2026-01-02T22:00:00.000Z']);
  assert.deepEqual(previewCron('0 0 */10 */5 *', 'UTC', now).nextRuns,
    ['2026-01-11T00:00:00.000Z', '2026-01-21T00:00:00.000Z', '2026-01-31T00:00:00.000Z']);
  assert.equal(previewCron('0 0 1 */5 *', 'UTC', now).nextRuns[0], '2026-06-01T00:00:00.000Z');
  assert.equal(previewCron('0 0 * * 2/2', 'UTC', now).nextRuns[0], '2026-01-03T00:00:00.000Z');
  assert.equal(previewCron('0/999 0 * * *', 'UTC', now).nextRuns[0], '2026-01-02T00:00:00.000Z');
});

test('day-of-month and weekday use AND, with Sunday zero', () => {
  assert.deepEqual(previewCron('0 0 13 * 5', 'UTC', at('2026-01-01T00:00:00Z')).nextRuns,
    ['2026-02-13T00:00:00.000Z', '2026-03-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z']);
  assert.equal(previewCron('0 0 * * 0', 'UTC', at('2026-01-01T00:00:00Z')).nextRuns[0], '2026-01-04T00:00:00.000Z');
});

test('calendar skips short months and rolls into the next year', () => {
  assert.deepEqual(previewCron('0 0 31 * *', 'UTC', at('2026-10-31T00:00:00Z')).nextRuns,
    ['2026-12-31T00:00:00.000Z', '2027-01-31T00:00:00.000Z', '2027-03-31T00:00:00.000Z']);
});

test('rejects non-numeric syntax, malformed lists, invalid bounds and strides', () => {
  const bad = ['', null, 42, {}, '@daily', '* * * *', '* * * * * *', '0 8 * * MON', '0 8 * JAN *',
    '0 8 ? * *', '0 8 L * *', '0 8 * * 1#2', '0 8 * * 7', '60 * * * *', '* 24 * * *',
    '* * 0 * *', '* * 32 * *', '* * * 0 *', '* * * 13 *', '* * * * -1'];
  for (const field of ['1,', ',1', '1,,2', '1,garbage', '2-1', '2-1/2', '0-60', '0-60/2', '*/0', '*/-1',
    '*/1.5', '1/0', '/2', '1/', '*//2', '1/2/3', '1-2-3', '1-2-3/2', '1foo', '1.2', '+1', '1e1',
    '0x10', '1/2foo', '1-2foo', '*/9007199254740992', '9'.repeat(400)]) bad.push(`${field} * * * *`);
  for (const cron of bad) assert.throws(() => previewCron(cron, 'UTC', 0), { code: 'invalid_cron', status: 400 }, String(cron));
});

test('requires explicit Intl-validated IANA timezone or UTC', () => {
  for (const timezone of ['', null, 2, {}, 'local', 'EST', 'GMT', 'Z', '+02:00', 'UTC+2', ' UTC ', 'Africa/Not_A_Place']) {
    assert.throws(() => previewCron('* * * * *', timezone, 0), { code: 'invalid_timezone', status: 400 });
  }
  assert.equal(previewCron('0 0 * * *', 'Asia/Kathmandu', at('2026-01-01T00:00:00Z')).nextRuns[0], '2026-01-01T18:15:00.000Z');
  assert.equal(previewCron('0 0 * * *', 'Etc/GMT+5', at('2026-01-01T00:00:00Z')).nextRuns[0], '2026-01-01T05:00:00.000Z');
  assert.equal(previewCron('0 0 * * *', 'Pacific/Kiritimati', at('2026-01-01T00:00:00Z')).nextRuns[0], '2026-01-01T10:00:00.000Z');
});

test('invalid clocks fail explicitly rather than searching or coercing', () => {
  for (const now of [NaN, Infinity, -Infinity, null, '2026-01-01', new Date(), 8.64e15, -8.64e15, 1n, Symbol('now')]) {
    assert.throws(() => previewCron('* * * * *', 'UTC', now), { code: 'invalid_now', status: 400 });
  }
});

test('spring-forward skips nonexistent local minutes', () => {
  assert.deepEqual(previewCron('30 2 * * *', 'America/New_York', at('2026-03-07T08:00:00Z')).nextRuns,
    ['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z', '2026-03-11T06:30:00.000Z']);
});

test('fall-back returns both occurrences and sorts instants rather than wall times', () => {
  assert.deepEqual(previewCron('0,30 1 * * *', 'America/New_York', at('2026-11-01T04:59:00Z')).nextRuns,
    ['2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T06:00:00.000Z']);
  assert.deepEqual(previewCron('30 1 * * *', 'America/New_York', at('2026-11-01T05:45:00Z')).nextRuns,
    ['2026-11-01T06:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
});

test('half-hour DST shifts and whole-day date-line jumps', () => {
  assert.deepEqual(previewCron('45 1 * * *', 'Australia/Lord_Howe', at('2026-04-04T14:44:00Z')).nextRuns,
    ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z', '2026-04-05T15:15:00.000Z']);
  assert.deepEqual(previewCron('15 2 * * *', 'Australia/Lord_Howe', at('2026-10-02T16:00:00Z')).nextRuns,
    ['2026-10-04T15:15:00.000Z', '2026-10-05T15:15:00.000Z', '2026-10-06T15:15:00.000Z']);
  assert.deepEqual(previewCron('0 0 * * *', 'Pacific/Apia', at('2011-12-29T09:59:00Z')).nextRuns,
    ['2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z', '2011-12-31T10:00:00.000Z']);
});

test('leap-day and rare weekday previews return partial results within one shared horizon', t => {
  let calls = 0;
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (...args) {
    calls++;
    return original.apply(this, args);
  });
  const leap = previewCron('0 0 29 2 *', 'Africa/Johannesburg', at('2026-01-01T00:00:00Z'));
  assert.deepEqual(leap.nextRuns, ['2028-02-28T22:00:00.000Z']);
  assert.equal(leap.horizonEnded, true);
  assert.ok(leap.warnings.some(warning => /horizon ended/.test(warning)));
  const rare = previewCron('0 0 29 2 2', 'UTC', at('2026-01-01T00:00:00Z'));
  assert.deepEqual(rare.nextRuns, ['2028-02-29T00:00:00.000Z']);
  assert.equal(rare.horizonEnded, true);
  const two = previewCron('0 0 29 2 *', 'UTC', at('2023-03-01T00:00:00Z'));
  assert.deepEqual(two.nextRuns, ['2024-02-29T00:00:00.000Z', '2028-02-29T00:00:00.000Z']);
  assert.equal(two.horizonEnded, true);
  assert.ok(calls < 500, `Sparse previews made ${calls} Intl calls instead of skipping calendar days`);
});

test('impossible dates and no occurrence within the horizon are rejected without minute scans', t => {
  let calls = 0;
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (...args) {
    calls++;
    return original.apply(this, args);
  });
  for (const cron of ['0 0 31 2 *', '0 0 31 4 *', '0 0 30 2 *', '0 0 29 2 1']) {
    assert.throws(() => previewCron(cron, 'UTC', at('2026-01-01T00:00:00Z')),
      { code: 'invalid_cron', message: /no matching run.*five-year/ });
  }
  assert.throws(() => previewCron('0 0 29 2 *', 'UTC', at('2097-01-01T00:00:00Z')), { code: 'invalid_cron' });
  assert.equal(calls, 0, 'Calendar-impossible schedules need no timezone conversion');
});

test('the shared horizon includes its first minute but excludes its end', () => {
  const leap = at('2028-02-29T00:00:00Z');
  const beforeHorizon = leap - 1830 * 86400000 - 60000;
  assert.deepEqual(previewCron('0 0 29 2 *', 'UTC', beforeHorizon).nextRuns, ['2024-02-29T00:00:00.000Z']);
  assert.deepEqual(previewCron('0 0 29 2 *', 'UTC', beforeHorizon + 60000).nextRuns,
    ['2024-02-29T00:00:00.000Z', '2028-02-29T00:00:00.000Z']);
  assert.equal(previewCron('0 0 29 2 *', 'UTC', leap - 1).nextRuns[0], '2028-02-29T00:00:00.000Z');
});

test('calendar conversion agrees with an independent UTC-minute scan around transitions', () => {
  const cases = [
    ['America/New_York', '2026-03-08T05:01:00Z', [15, 30], [1, 2, 3]],
    ['America/New_York', '2026-11-01T05:31:00Z', [0, 30], [1, 2]],
    ['Europe/Berlin', '2026-10-25T00:31:00Z', [0, 30], [2, 3]],
    ['Australia/Lord_Howe', '2026-04-04T14:51:00Z', [0, 15, 45], [1, 2]],
    ['Pacific/Apia', '2011-12-29T10:01:00Z', [0, 15], [0, 1]],
    ['Africa/Monrovia', '1972-01-06T23:40:00Z', [0, 15, 45], [0, 1]],
  ];
  for (const [timezone, start, minutes, hours] of cases) {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    const expected = [];
    for (let instant = at(start) + 60000, steps = 0; expected.length < 3 && steps < 3 * 1440; instant += 60000, steps++) {
      const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
      if (hours.includes(Number(parts.hour)) && minutes.includes(Number(parts.minute))) expected.push(new Date(instant).toISOString());
    }
    assert.equal(expected.length, 3, `Reference scan exhausted for ${timezone}`);
    assert.deepEqual(previewCron(`${minutes.join(',')} ${hours.join(',')} * * *`, timezone, at(start)).nextRuns, expected, timezone);
  }
});
