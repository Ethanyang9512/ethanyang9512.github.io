import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDuration, href, isoBeijing, isoDuration, parseDate } from '../lib/format.mjs';

test('formatDate shows the Beijing date', () => {
  // UTC 17:20 在东八区已是次日 01:20
  assert.equal(formatDate('2026-09-06T17:20:00.269Z'), '2026-09-07');
  assert.equal(formatDate('2026-09-06T15:59:59.999Z'), '2026-09-06');
  // 博客只写日期时不能跨天
  assert.equal(formatDate('2026-03-01'), '2026-03-01');
});

test('dates without a time zone are read as UTC+8', (t) => {
  // 构建机的时区不能影响结果（各台机器时区不同，Actions 是 UTC）。把这个进程的时区改成 UTC 来试
  const saved = process.env.TZ;
  t.after(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
  process.env.TZ = 'UTC';

  assert.equal(parseDate('2026-03-01'), Date.parse('2026-02-28T16:00:00Z'));
  assert.equal(parseDate('2026-03-01T23:30'), Date.parse('2026-03-01T15:30:00Z'));
  assert.equal(parseDate('2026-03-01 23:30:15'), Date.parse('2026-03-01T15:30:15Z'));
  assert.equal(formatDate('2026-03-01T23:30'), '2026-03-01');
  // 写了时区的照原样
  assert.equal(parseDate('2026-09-06T17:20:00.269Z'), Date.parse('2026-09-06T17:20:00.269Z'));
  assert.equal(parseDate('2026-03-01T23:30:00-05:00'), Date.parse('2026-03-02T04:30:00Z'));
  // 认不出的写法不猜
  for (const text of ['2026/03/01', 'March 1, 2026', '不是日期', '']) assert.ok(Number.isNaN(parseDate(text)), text);
});

test('formatDuration rounds to whole minutes', () => {
  assert.equal(formatDuration(1292), '22 分钟');
  assert.equal(formatDuration(1289), '21 分钟');
  assert.equal(formatDuration(3700), '1 小时 2 分钟');
  // 先四舍五入再判断满不满 60 分钟：59.5 分钟算 1 小时
  assert.equal(formatDuration(3570), '1 小时 0 分钟');
});

test('isoDuration writes ISO 8601 durations', () => {
  assert.equal(isoDuration(1292), 'PT21M32S');
  assert.equal(isoDuration(3700), 'PT1H1M40S');
  assert.equal(isoDuration(1200), 'PT20M');
  assert.equal(isoDuration(0), 'PT0S');
});

test('href is relative to the page', () => {
  assert.equal(href('/podcast/', '/works/ai-analyst-workbench/'), '../works/ai-analyst-workbench/');
  assert.equal(href('/', '/works/'), 'works/');
  assert.equal(href('/works/', '/works/alpha/'), 'alpha/');
  assert.equal(href('/works/alpha/', '/'), '../../');
  assert.equal(href('/', '/'), './');
  assert.equal(href('/works/alpha/', '/assets/site.css'), '../../assets/site.css');
  assert.equal(href('/blog/a/', '/blog/feed.xml'), '../feed.xml');
});

test('href in preview ends directory links with index.html', () => {
  const preview = { preview: true };
  assert.equal(href('/podcast/', '/works/ai-analyst-workbench/', preview), '../works/ai-analyst-workbench/index.html');
  assert.equal(href('/works/alpha/', '/', preview), '../../index.html');
  assert.equal(href('/', '/', preview), 'index.html');
  // 文件链接不变
  assert.equal(href('/works/alpha/', '/assets/site.css', preview), '../../assets/site.css');
});

test('isoBeijing writes the same moment with a +08:00 offset', () => {
  // 只截日期的读者读到的，和页面上显示的日期是同一天
  assert.equal(isoBeijing('2026-09-06T17:20:00.269Z'), '2026-09-07T01:20:00+08:00');
  assert.equal(isoBeijing('2026-09-06T15:59:59.999Z'), '2026-09-06T23:59:59+08:00');
  assert.equal(isoBeijing('2026-03-01'), '2026-03-01T00:00:00+08:00');
  assert.equal(formatDate('2026-09-06T17:20:00.269Z'), isoBeijing('2026-09-06T17:20:00.269Z').slice(0, 10));
});
