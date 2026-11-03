import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePodcastPage } from '../lib/podcast-source.mjs';

// 夹具全是手写假数据。临时目录留在系统临时目录里由系统清理，测试不删文件。
const FIXTURE = fileURLToPath(new URL('./fixtures/podcast-page.html', import.meta.url));
const SYNC = fileURLToPath(new URL('../scripts/sync-podcast.mjs', import.meta.url));
const pageHtml = await readFile(FIXTURE, 'utf8');

const PID = 'fb0000000000000000000001';
const episode = (eid, title, pubDate, duration) => ({
  eid,
  title,
  pubDate,
  duration,
  url: `https://www.xiaoyuzhoufm.com/episode/${eid}`,
});
// 夹具页面里 3 期单集应当解析成的样子（手算）
const EPISODES = [
  episode('f90000000000000000000003', 'Vol.03 夹具第三期："引号" & 符号', '2026-03-15T12:00:00.123Z', 1500),
  episode('f90000000000000000000002', 'Vol.02 夹具第二期', '2026-02-15T12:00:00.000Z', 1800),
  episode('f90000000000000000000001', 'Vol.01 夹具第一期', '2026-01-15T12:00:00.000Z', 2400),
];
// 假种子：比页面上的都早，页面上没有
const SEEDS = [
  episode('fc000000000000000000000b', '夹具种子 Vol.0', '2025-12-20T10:00:00.000Z', 1200),
  episode('fc000000000000000000000a', '夹具种子 Vol.-1', '2025-12-01T10:00:00.000Z', 900),
];

const pageWith = (podcast) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { podcast } } })}</script></body></html>`;
const podcastWith = (episodes) => ({ pid: PID, title: '夹具播客', episodeCount: 5, episodes });

async function makeDataDir({ podcastJson } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'site-test-'));
  await writeFile(join(dir, 'seed-episodes.json'), `${JSON.stringify(SEEDS, null, 2)}\n`);
  if (podcastJson !== undefined) await writeFile(join(dir, 'podcast.json'), podcastJson);
  return dir;
}

function runSync(sourceFile, dataDir) {
  const r = spawnSync(process.execPath, [SYNC, '--source-file', sourceFile, '--data-dir', dataDir], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, all: r.stdout + r.stderr };
}

async function writeSource(dir, name, html) {
  const file = join(dir, name);
  await writeFile(file, html);
  return file;
}

const readJson = async (dir, name) => JSON.parse(await readFile(join(dir, name), 'utf8'));

test('sync script runs without node_modules: everything it imports is built in or a local file with the same property', async () => {
  // 每天的同步以前不用装依赖就能直接跑，现在也要能。它引的本地文件一层层往下，只能引 node: 内置模块和本地文件，
  // 不能引 marked 这类装在 node_modules 里的包（lib/data.mjs 经 blog.mjs 会牵出 marked，所以 held.json 的规则放在没有依赖的 lib/held.mjs）
  const seen = new Set();
  const packages = [];
  async function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of (await readFile(file, 'utf8')).matchAll(/\bfrom\s+'([^']+)'/g)) {
      if (spec.startsWith('.')) await walk(resolve(dirname(file), spec));
      else if (!spec.startsWith('node:')) packages.push(`${file}: ${spec}`);
    }
  }
  await walk(SYNC);
  assert.deepEqual(packages, []);
  const names = [...seen].map((f) => f.slice(f.indexOf('/lib/') + 1)).filter((f) => f.startsWith('lib/'));
  assert.ok(names.includes('lib/held.mjs'), names.join(' '));
  assert.ok(!names.includes('lib/data.mjs') && !names.includes('lib/blog.mjs'), names.join(' '));
});

test('page parse keeps only 5 fields', () => {
  const result = parsePodcastPage(pageHtml);

  assert.deepEqual(result, {
    podcast: { pid: PID, title: '夹具播客', episodeCount: 5 },
    episodes: EPISODES,
  });
  const json = JSON.stringify(result);
  for (const banned of ['ipLoc', 'contacts', 'description', 'shownotes', '@', '泄露标记', 'example.invalid']) {
    assert.ok(!json.includes(banned), `输出里不该有 ${banned}`);
  }
});

test('sync refuses empty or missing data', async () => {
  const noNextData = '<html><body><div id="__next">改版后的页面，没有 __NEXT_DATA__ 脚本</div></body></html>';
  const noEpisodes = pageWith(podcastWith([]));
  assert.throws(() => parsePodcastPage(noNextData), { message: 'NO_NEXT_DATA' });
  assert.throws(() => parsePodcastPage(noEpisodes), { message: 'NO_EPISODES' });

  // 页面改版、字段缺了或变了：报 PARSE，不拿半截数据凑
  const raw = { eid: 'f90000000000000000000009', title: '夹具', pubDate: '2026-01-01T00:00:00.000Z', duration: 60 };
  const malformed = [
    podcastWith([{ ...raw, eid: undefined }]),
    podcastWith([{ ...raw, pubDate: '不是日期' }]),
    podcastWith([{ ...raw, duration: undefined }]),
    { ...podcastWith([raw]), episodeCount: undefined },
  ];
  for (const podcast of malformed) {
    assert.throws(() => parsePodcastPage(pageWith(podcast)), { message: 'PARSE' });
  }

  // 命令行：退出 1，只打印错误码，已有的 podcast.json 一个字节都不动
  const existing = `${JSON.stringify(
    {
      podcast: { pid: PID, title: '夹具播客', url: `https://www.xiaoyuzhoufm.com/podcast/${PID}`, episodeCount: 5, checkedAt: '2026-01-20T00:00:00.000Z' },
      episodes: [...EPISODES, ...SEEDS],
    },
    null,
    2,
  )}\n`;
  const dir = await makeDataDir({ podcastJson: existing });
  for (const [html, code] of [
    [noNextData, 'E_NO_NEXT_DATA'],
    [noEpisodes, 'E_NO_EPISODES'],
  ]) {
    const r = runSync(await writeSource(dir, 'source.html', html), dir);
    assert.equal(r.code, 1);
    assert.equal(r.all.trim(), code);
    assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), existing);
  }
});

test('sync failure prints only error code', async () => {
  const marker = '夹具标记XYZ';
  // 值没加引号：这类错误 Node 会把出错位置附近的原文写进报错（有的错误类型不带，所以先验证）
  const brokenJson = `{"props":{"pageProps":{"podcast":{"title":${marker},"episodes":[]}}}}`;
  // 先证明这个测试有意义：Node 原生的 JSON 报错会把标记串带出来
  assert.throws(() => JSON.parse(brokenJson), (err) => err.message.includes(marker));

  const broken = `<html><body><script id="__NEXT_DATA__" type="application/json">${brokenJson}</script></body></html>`;
  assert.throws(
    () => parsePodcastPage(broken),
    (err) => err.message === 'PARSE' && err.cause === undefined,
  );

  const dir = await makeDataDir();
  const r = runSync(await writeSource(dir, 'broken.html', broken), dir);
  assert.equal(r.code, 1);
  assert.ok(!r.all.includes(marker));
  assert.equal(r.all.trim(), 'E_PARSE');

  // 不是解析器抛的错（比如站里自己的数据文件坏了）也只打印错误码
  const badData = `{"episodes": [${marker}`;
  assert.throws(() => JSON.parse(badData), (err) => err.message.includes(marker));
  const dir2 = await makeDataDir({ podcastJson: badData });
  const r2 = runSync(FIXTURE, dir2);
  assert.equal(r2.code, 1);
  assert.ok(!r2.all.includes(marker));
  assert.equal(r2.all.trim(), 'E_INTERNAL');
});

test('sync writes only whitelisted fields and prints no titles', async () => {
  const dir = await makeDataDir();

  const r = runSync(FIXTURE, dir);

  assert.equal(r.code, 0, r.all);
  const saved = JSON.parse(await readFile(join(dir, 'podcast.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['podcast', 'episodes']);
  const { checkedAt, ...podcast } = saved.podcast;
  assert.deepEqual(podcast, {
    pid: PID,
    title: '夹具播客',
    url: 'https://www.xiaoyuzhoufm.com/podcast/fb0000000000000000000001',
    episodeCount: 5,
  });
  assert.match(checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(saved.episodes, [...EPISODES, ...SEEDS]);
  assert.equal(
    r.all,
    '新增 5 期：f90000000000000000000003 f90000000000000000000002 f90000000000000000000001 fc000000000000000000000b fc000000000000000000000a\n' +
      '站上 5 期 / 来源 5 期\n',
  );
});

test('sync leaves podcast.json untouched when nothing changed', async () => {
  const dir = await makeDataDir();
  assert.equal(runSync(FIXTURE, dir).code, 0);
  const first = await readFile(join(dir, 'podcast.json'), 'utf8');

  const r = runSync(FIXTURE, dir);

  assert.equal(r.code, 0, r.all);
  assert.equal(r.all, '新增 0 期：\n站上 5 期 / 来源 5 期\n');
  // 连 checkedAt 都不变：不让每天的同步产生只改时间戳的提交
  assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), first);
});

test('seed episodes survive a sync', async () => {
  // podcast.json 被重建（文件不存在），或旧文件里恰好没有种子：同步后种子都在，值照种子
  const withoutSeeds = `${JSON.stringify({ podcast: { pid: PID, title: '夹具播客', url: `https://www.xiaoyuzhoufm.com/podcast/${PID}`, episodeCount: 5, checkedAt: '2026-01-20T00:00:00.000Z' }, episodes: [EPISODES[0]] }, null, 2)}\n`;
  for (const podcastJson of [undefined, withoutSeeds]) {
    const dir = await makeDataDir({ podcastJson });

    const r = runSync(FIXTURE, dir);

    assert.equal(r.code, 0, r.all);
    const saved = JSON.parse(await readFile(join(dir, 'podcast.json'), 'utf8'));
    for (const seed of SEEDS) {
      assert.deepEqual(saved.episodes.find((e) => e.eid === seed.eid), seed);
    }
    assert.equal(saved.episodes.length, 5);
  }
});

// 已有数据：页面上的 3 期 + 种子 + extra（手写的假单集）。episodeCount 是上次同步记下的来源总期数，默认和已知的期数一样
const podcastJsonWith = (extra, episodeCount = EPISODES.length + SEEDS.length + extra.length) =>
  `${JSON.stringify(
    {
      podcast: { pid: PID, title: '夹具播客', url: `https://www.xiaoyuzhoufm.com/podcast/${PID}`, episodeCount, checkedAt: '2026-01-20T00:00:00.000Z' },
      episodes: [...EPISODES, ...extra, ...SEEDS].sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate)),
    },
    null,
    2,
  )}\n`;
// 发布时间落在页面这一批（最旧的是 2026-01-15）里，页面上却没有：在小宇宙上被删了
const GONE = episode('f90000000000000000000004', '夹具被删的一期', '2026-02-01T12:00:00.000Z', 1600);
// 比页面这一批最旧的那期还早：本来就不在页面上，不能当成被删
const OLDER = episode('f90000000000000000000005', '夹具更早的一期', '2026-01-10T12:00:00.000Z', 1700);

test('sync takes nothing down while the source count has not dropped', async () => {
  // 页面可能一时不完整：少了一期，总期数却没变少，就不下架，两个文件都不动，只靠期数核对
  const cases = [
    // 已知 6 期、上次记下 6 期；这次页面上缺了 GONE，总期数还是 6
    { podcastJson: podcastJsonWith([GONE]), page: { ...podcastWith(EPISODES), episodeCount: 6 }, out: '站上 6 期 / 来源 6 期' },
    // 页面上缺了最新的一期，总期数还是 5
    { podcastJson: podcastJsonWith([]), page: podcastWith(EPISODES.slice(1)), out: '站上 5 期 / 来源 5 期' },
    // 站上本来就比来源多一期（以前删掉的是窗口外的旧期，认不出是哪期），上次记下的是 5：
    // 比的是上次记下的总期数，不是站上的期数，所以这次缺了最新的一期也不下架
    { podcastJson: podcastJsonWith([OLDER], 5), page: podcastWith(EPISODES.slice(1)), out: '站上 6 期 / 来源 5 期' },
  ];
  for (const { podcastJson, page, out } of cases) {
    const dir = await makeDataDir({ podcastJson });

    const r = runSync(await writeSource(dir, 'page.html', pageWith(page)), dir);

    assert.equal(r.code, 0, r.all);
    assert.equal(r.all, `新增 0 期：\n${out}\n`);
    assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), podcastJson);
    await assert.rejects(readFile(join(dir, 'held.json'), 'utf8'), { code: 'ENOENT' });
  }
});

test('sync takes down an episode deleted at the source', async () => {
  // 上次记下 6 期，这次页面（夹具）说 5 期，页面这一批的时间范围里少了 GONE：判为小宇宙上删了
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([GONE]) });
  // held.json 里已有的项（看门撤下的、别的键）原样保留，GONE 只记进 deleted
  const heldBefore = { episodes: ['fd0000000000000000000001'], releases: ['fixture-repo:v0.1.0'], posts: ['fixture-post'] };
  await writeFile(join(dir, 'held.json'), `${JSON.stringify(heldBefore, null, 2)}\n`);

  const r = runSync(FIXTURE, dir);

  assert.equal(r.code, 0, r.all);
  // 只打印编号和期数，不打印标题
  assert.equal(r.all, `新增 0 期：\n下架 1 期：${GONE.eid}\n站上 5 期 / 来源 5 期\n`);
  assert.ok(!r.all.includes(GONE.title));
  assert.deepEqual(await readJson(dir, 'held.json'), { ...heldBefore, deleted: [GONE.eid] });
  // 删了的那期从单集数据里去掉，标题不再留在公开的 podcast.json 里
  const podcastText = await readFile(join(dir, 'podcast.json'), 'utf8');
  const saved = JSON.parse(podcastText);
  assert.deepEqual(saved.episodes, [...EPISODES, ...SEEDS]);
  assert.equal(saved.podcast.episodeCount, 5);
  assert.ok(!podcastText.includes(GONE.title));

  // 再跑一次：不重复记、不再打印，两个文件一个字节都不动
  const heldText = await readFile(join(dir, 'held.json'), 'utf8');
  const again = runSync(FIXTURE, dir);
  assert.equal(again.code, 0, again.all);
  assert.equal(again.all, '新增 0 期：\n站上 5 期 / 来源 5 期\n');
  assert.equal(await readFile(join(dir, 'held.json'), 'utf8'), heldText);
  assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), podcastText);

  // 删之前的缓存页面（还有 GONE、总期数 6）：页面上又有了它，按规则恢复；
  // 下一次拿到新的页面（5 期），总期数又比上次少，再下架。这是用旧缓存换来自动恢复的代价
  const cached = pageWith({ ...podcastWith([...EPISODES, GONE]), episodeCount: 6 });
  const back = runSync(await writeSource(dir, 'cached.html', cached), dir);
  assert.equal(back.all, `新增 1 期：${GONE.eid}\n恢复 1 期：${GONE.eid}\n站上 6 期 / 来源 6 期\n`);
  assert.deepEqual((await readJson(dir, 'held.json')).deleted, []);
  const fresh = runSync(FIXTURE, dir);
  assert.equal(fresh.all, `新增 0 期：\n下架 1 期：${GONE.eid}\n站上 5 期 / 来源 5 期\n`);
  assert.deepEqual((await readJson(dir, 'held.json')).deleted, [GONE.eid]);
});

test('sync restores an episode that a stale page took down', async () => {
  // 一整页旧缓存：缺最新一期，总期数也少 1。页面内容上它和“最新一期真被删了”一模一样，当天只能下架
  const [latest, ...rest] = EPISODES;
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([]) });

  const stale = runSync(await writeSource(dir, 'stale.html', pageWith({ ...podcastWith(rest), episodeCount: 4 })), dir);

  assert.equal(stale.code, 0, stale.all);
  assert.equal(stale.all, `新增 0 期：\n下架 1 期：${latest.eid}\n站上 4 期 / 来源 4 期\n`);
  assert.deepEqual(await readJson(dir, 'held.json'), { episodes: [], releases: [], posts: [], deleted: [latest.eid] });
  assert.deepEqual((await readJson(dir, 'podcast.json')).episodes, [...rest, ...SEEDS]);

  // 下一次是正常的页面（夹具）：页面上又有了它，自动恢复，deleted 清空
  const back = runSync(FIXTURE, dir);

  assert.equal(back.code, 0, back.all);
  assert.equal(back.all, `新增 1 期：${latest.eid}\n恢复 1 期：${latest.eid}\n站上 5 期 / 来源 5 期\n`);
  assert.ok(!back.all.includes(latest.title));
  assert.deepEqual(await readJson(dir, 'held.json'), { episodes: [], releases: [], posts: [], deleted: [] });
  const saved = await readJson(dir, 'podcast.json');
  assert.deepEqual(saved.episodes, [...EPISODES, ...SEEDS]);
  assert.equal(saved.podcast.episodeCount, 5);

  // 再跑一次：两个文件一个字节都不动，也不再打印恢复
  const heldText = await readFile(join(dir, 'held.json'), 'utf8');
  const podcastText = await readFile(join(dir, 'podcast.json'), 'utf8');
  const again = runSync(FIXTURE, dir);
  assert.equal(again.all, '新增 0 期：\n站上 5 期 / 来源 5 期\n');
  assert.equal(await readFile(join(dir, 'held.json'), 'utf8'), heldText);
  assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), podcastText);
});

test('sync keeps an episode deleted at the source in deleted', async () => {
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([GONE]) });
  assert.equal(runSync(FIXTURE, dir).code, 0); // 第一次：下架

  // 之后的页面一直没有它：原样的页面，和后来又发了新一期（总期数变多）的页面。一直留在 deleted，不会回到 podcast.json
  const NEWER = episode('f90000000000000000000007', '夹具新发的一期', '2026-04-01T12:00:00.000Z', 1000);
  const withNewer = pageWith({ ...podcastWith([NEWER, ...EPISODES]), episodeCount: 6 });
  for (const html of [pageHtml, withNewer, withNewer]) {
    const r = runSync(await writeSource(dir, 'later.html', html), dir);

    assert.equal(r.code, 0, r.all);
    assert.ok(!r.all.includes('恢复') && !r.all.includes('下架'), r.all);
    assert.deepEqual((await readJson(dir, 'held.json')).deleted, [GONE.eid]);
    assert.ok(!(await readJson(dir, 'podcast.json')).episodes.some((e) => e.eid === GONE.eid));
  }
  assert.ok((await readJson(dir, 'podcast.json')).episodes.some((e) => e.eid === NEWER.eid));
});

test('sync never changes the episodes list the watchdog keeps', async () => {
  // 看门因隐私撤下的单集在 episodes 里：同步不增、不减、不跳过它们，别的键也原样留着。
  // 其中最新的一期还在数据里，下面让它被误下架、再恢复一轮：episodes 照样一个字不动
  const [latest, ...rest] = EPISODES;
  const heldBefore = {
    episodes: [latest.eid, 'fd0000000000000000000001'],
    releases: ['fixture-repo:v0.1.0'],
    posts: ['fixture-post'],
    note: ['别的键'],
  };
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([]) });
  await writeFile(join(dir, 'held.json'), `${JSON.stringify(heldBefore, null, 2)}\n`);
  const heldText = await readFile(join(dir, 'held.json'), 'utf8');
  const othersUnchanged = async () => {
    const { deleted, ...others } = await readJson(dir, 'held.json');
    assert.deepEqual(others, heldBefore);
    return deleted;
  };

  // 没有要下架的：held.json 一个字节都不动；撤下的那期还在 podcast.json 里（站上不算它）
  const plain = runSync(FIXTURE, dir);
  assert.equal(plain.all, '新增 0 期：\n站上 4 期 / 来源 5 期\n');
  assert.equal(await readFile(join(dir, 'held.json'), 'utf8'), heldText);
  assert.deepEqual((await readJson(dir, 'podcast.json')).episodes, [...EPISODES, ...SEEDS]);

  // 下架：只多一个 deleted
  const stale = pageWith({ ...podcastWith(rest), episodeCount: 4 });
  const down = runSync(await writeSource(dir, 'stale.html', stale), dir);
  assert.equal(down.all, `新增 0 期：\n下架 1 期：${latest.eid}\n站上 4 期 / 来源 4 期\n`);
  assert.deepEqual(await othersUnchanged(), [latest.eid]);

  // 恢复：deleted 清空，episodes 还是那一份，那期回到 podcast.json 里
  const up = runSync(FIXTURE, dir);
  assert.equal(up.all, `新增 1 期：${latest.eid}\n恢复 1 期：${latest.eid}\n站上 4 期 / 来源 5 期\n`);
  assert.deepEqual(await othersUnchanged(), []);
  assert.deepEqual((await readJson(dir, 'podcast.json')).episodes, [...EPISODES, ...SEEDS]);
});

test('sync does not put a deleted seed episode back from the seed file', async () => {
  // 页面上有一期比较早的种子（SEEDS[1]），所以另一期种子（SEEDS[0]）落在页面这一批的时间范围里；
  // 它不在页面上、总期数又少了 1：判为被删。种子文件里还有它，但不能每次同步又并回来
  const [seed, olderSeed] = SEEDS;
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([]) });
  const page = await writeSource(dir, 'page.html', pageWith({ ...podcastWith([...EPISODES, olderSeed]), episodeCount: 4 }));

  const first = runSync(page, dir);

  assert.equal(first.all, `新增 0 期：\n下架 1 期：${seed.eid}\n站上 4 期 / 来源 4 期\n`);
  assert.deepEqual((await readJson(dir, 'held.json')).deleted, [seed.eid]);
  const podcastText = await readFile(join(dir, 'podcast.json'), 'utf8');
  assert.deepEqual(JSON.parse(podcastText).episodes, [...EPISODES, olderSeed]);

  const again = runSync(page, dir);
  assert.equal(again.all, '新增 0 期：\n站上 4 期 / 来源 4 期\n');
  assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), podcastText);
});

test('sync finishes taking down an episode that deleted lists but podcast.json still has', async () => {
  // 上次只写成了 held.json（deleted 里有 GONE），podcast.json 里还留着它：这次页面上没有它，从 podcast.json 里去掉，
  // 已经记在 deleted 里的不重复记，held.json 一个字节都不动
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([GONE]) });
  const heldText = `${JSON.stringify({ episodes: [], releases: [], posts: [], deleted: [GONE.eid] }, null, 2)}\n`;
  await writeFile(join(dir, 'held.json'), heldText);

  const r = runSync(FIXTURE, dir);

  assert.equal(r.code, 0, r.all);
  assert.equal(r.all, '新增 0 期：\n站上 5 期 / 来源 5 期\n');
  assert.equal(await readFile(join(dir, 'held.json'), 'utf8'), heldText);
  assert.deepEqual((await readJson(dir, 'podcast.json')).episodes, [...EPISODES, ...SEEDS]);
});

test('sync does not take older episodes outside the page window as deleted', async () => {
  // 总期数从 6 变成 5，但 OLDER 和两期种子都比页面这一批最旧的那期早，不在页面上是正常的：
  // 认不出删的是哪期，不下架，只靠期数核对
  const dir = await makeDataDir({ podcastJson: podcastJsonWith([OLDER]) });

  const r = runSync(FIXTURE, dir);

  assert.equal(r.code, 0, r.all);
  assert.equal(r.all, '新增 0 期：\n站上 6 期 / 来源 5 期\n');
  // 没有要撤下的：held.json 不建也不改
  await assert.rejects(readFile(join(dir, 'held.json'), 'utf8'), { code: 'ENOENT' });
});

test('sync refuses a page of another podcast', async () => {
  // 节目页被跳转到别的节目：不合并别人的单集，也不把自己的单集当成被删
  const existing = podcastJsonWith([GONE]);
  const dir = await makeDataDir({ podcastJson: existing });
  const other = pageWith({ ...podcastWith(EPISODES), pid: 'fb0000000000000000000002' });

  const r = runSync(await writeSource(dir, 'other.html', other), dir);

  assert.equal(r.code, 1);
  assert.equal(r.all.trim(), 'E_OTHER_PODCAST');
  assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), existing);
  await assert.rejects(readFile(join(dir, 'held.json'), 'utf8'), { code: 'ENOENT' });
});

test('sync reads held.json by the same rules as the build: missing lists count as empty', async () => {
  // {}、缺 episodes、旧文件没有 deleted：构建都当缺的清单是空的，同步也一样，照常跑；
  // 当天有下架就只往里加 deleted，别的内容原样留着（不替它补键）
  const cases = [{}, { releases: ['fixture-repo:v0.1.0'], posts: [] }, { episodes: [], releases: [], posts: [] }, { note: ['别的键'] }];
  for (const heldBefore of cases) {
    const dir = await makeDataDir({ podcastJson: podcastJsonWith([GONE]) });
    await writeFile(join(dir, 'held.json'), `${JSON.stringify(heldBefore, null, 2)}\n`);

    const r = runSync(FIXTURE, dir);

    assert.equal(r.code, 0, `${JSON.stringify(heldBefore)}：${r.all}`);
    assert.equal(r.all, `新增 0 期：\n下架 1 期：${GONE.eid}\n站上 5 期 / 来源 5 期\n`);
    assert.deepEqual(await readJson(dir, 'held.json'), { ...heldBefore, deleted: [GONE.eid] });
  }
});

test('sync refuses a malformed held.json with the same code as the build and writes nothing', async () => {
  // 构建遇到这些格式会报 E_HELD；同步也一样报，不能悄悄当成空清单再重写（那会把坏格式盖掉）。
  // 下面的数据让同步当天本来要下架 GONE：照样什么都不写
  const cases = [
    [{ episodes: 'x', releases: [], posts: [] }, 'E_HELD episodes 应为字符串数组'],
    [{ episodes: [], releases: [], posts: [], deleted: 'x' }, 'E_HELD deleted 应为字符串数组'],
    // 内容是 JSON null：不是“文件不存在”，不能用默认的空清单
    [null, 'E_HELD held.json 应为对象'],
    [[GONE.eid], 'E_HELD held.json 应为对象'],
    // 同步自己不用 releases、posts，也和构建一样查
    [{ episodes: [], releases: ['fixture-repo:v0.1.0', 3], posts: [] }, 'E_HELD releases 应为字符串数组'],
    [{ episodes: [], releases: [], posts: null }, 'E_HELD posts 应为字符串数组'],
  ];
  const existing = podcastJsonWith([GONE]);
  for (const [held, expected] of cases) {
    const dir = await makeDataDir({ podcastJson: existing });
    const heldText = `${JSON.stringify(held)}\n`;
    await writeFile(join(dir, 'held.json'), heldText);

    const r = runSync(FIXTURE, dir);

    assert.equal(r.code, 1, heldText);
    assert.equal(r.all.trim(), expected, heldText);
    assert.equal(await readFile(join(dir, 'podcast.json'), 'utf8'), existing, heldText);
    assert.equal(await readFile(join(dir, 'held.json'), 'utf8'), heldText, heldText);
  }
});
