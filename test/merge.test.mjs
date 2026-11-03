import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEpisodes, removedEpisodes } from '../lib/merge.mjs';

// 手写假单集
const ep = (eid, title, pubDate, duration = 600) => ({
  eid,
  title,
  pubDate,
  duration,
  url: `https://www.xiaoyuzhoufm.com/episode/${eid}`,
});

const A = 'f900000000000000000000a1';
const B = 'f900000000000000000000b2';
const C = 'f900000000000000000000c3';
const D = 'f900000000000000000000d4';

test('merge never deletes', () => {
  const existing = [
    ep(A, '假一', '2026-01-01T00:00:00.000Z'),
    ep(B, '假二', '2026-01-02T00:00:00.000Z'),
    ep(C, '假三', '2026-01-03T00:00:00.000Z'),
  ];
  // 来源这次只给了 2 期（其中 C 重复），A、B 不在来源里也不能丢
  const incoming = [ep(D, '假四', '2026-01-04T00:00:00.000Z'), ep(C, '假三', '2026-01-03T00:00:00.000Z')];

  const { episodes, added } = mergeEpisodes(existing, incoming);

  assert.equal(episodes.length, 4);
  assert.deepEqual(added, [D]);
  assert.deepEqual(new Set(episodes.map((e) => e.eid)), new Set([A, B, C, D]));
});

test('merge updates title of existing eid', () => {
  const existing = [ep(A, '旧标题', '2026-01-01T00:00:00.000Z', 600)];
  const incoming = [ep(A, '新标题', '2026-01-01T08:00:00.000Z', 601)];

  const { episodes, added } = mergeEpisodes(existing, incoming);

  assert.deepEqual(added, []);
  assert.deepEqual(episodes, [ep(A, '新标题', '2026-01-01T08:00:00.000Z', 601)]);
});

test('stray seed key is dropped', () => {
  // 种子文件里多写了一个键：合并结果只留 5 个字段，多的键不会被带进 podcast.json
  const seed = { ...ep(A, '种子', '2026-01-01T00:00:00.000Z'), note: '多出来的键' };

  const { episodes } = mergeEpisodes([], [seed]);

  assert.deepEqual(episodes, [ep(A, '种子', '2026-01-01T00:00:00.000Z')]);
});

test('merge sorts by pubDate desc', () => {
  const existing = [ep(A, '最早', '2025-12-31T23:00:00.000Z'), ep(C, '中间', '2026-02-01T00:00:00.000Z')];
  const incoming = [ep(B, '最新', '2026-03-01T00:00:00.000Z'), ep(D, '次早', '2026-01-15T00:00:00.000Z')];

  const { episodes, added } = mergeEpisodes(existing, incoming);

  assert.deepEqual(episodes.map((e) => e.eid), [B, C, D, A]);
  assert.deepEqual(added, [B, D]);
});

test('an episode missing from the page window is reported', () => {
  // 页面这一批是 B、C、D（最旧的是 B）。A 比 B 还早，不在页面上是正常的；E 在这一批的时间范围里却不在页面上：缺掉了
  // （算不算删了由同步看总期数决定，见 podcast-source.test.mjs）
  const E = 'f900000000000000000000e5';
  const page = [ep(D, '假四', '2026-01-04T00:00:00.000Z'), ep(C, '假三', '2026-01-03T00:00:00.000Z'), ep(B, '假二', '2026-01-02T00:00:00.000Z')];
  const known = [
    ep(D, '假四', '2026-01-04T00:00:00.000Z'),
    ep(E, '假五', '2026-01-03T12:00:00.000Z'),
    ep(C, '假三', '2026-01-03T00:00:00.000Z'),
    ep(B, '假二', '2026-01-02T00:00:00.000Z'),
    ep(A, '假一', '2026-01-01T00:00:00.000Z'),
  ];

  assert.deepEqual(removedEpisodes(known, page), [E]);
  // 和这一批最旧的那期同一时刻也算在范围里（不早于）
  assert.deepEqual(removedEpisodes([ep(E, '假五', '2026-01-02T00:00:00.000Z')], page), [E]);
  // 早于范围的一律不算，哪怕只早 1 毫秒
  assert.deepEqual(removedEpisodes([ep(A, '假一', '2026-01-01T23:59:59.999Z')], page), []);
  // 都在页面上：没有被删的
  assert.deepEqual(removedEpisodes(page, page), []);
});
