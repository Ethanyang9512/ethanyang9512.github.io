import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../build.mjs';
import { keep } from '../lib/render.mjs';
import { plainText } from '../scripts/plain-text.mjs';

// 构建只用夹具站点：真实 assets/（样式和图片）+ test/fixtures/site/ 里手写的假数据和占位图。
// 不读真实 data/：小宇宙出新一期不能让测试失败。临时目录由系统清理（测试不删文件）。
const SITE = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/site/', import.meta.url));
const POST = fileURLToPath(new URL('./fixtures/post.md', import.meta.url));
const POST_FILES = fileURLToPath(new URL('./fixtures/fixture-first-post/', import.meta.url));
const FIGURE = join(POST_FILES, 'figure.png');
const BUILD = fileURLToPath(new URL('../build.mjs', import.meta.url));

const SITE_URL = 'https://fixture.example.invalid';
const PODCAST_URL = 'https://www.xiaoyuzhoufm.com/podcast/fb0000000000000000000001';
const episode = (n) => ({
  eid: `fe000000000000000000000${n}`,
  url: `https://www.xiaoyuzhoufm.com/episode/fe000000000000000000000${n}`,
});
const [EP1, EP2, EP3] = [episode(1), episode(2), episode(3)];
const ALPHA_ZIP = 'https://github.com/Ethanyang9512/alpha-kit/archive/refs/tags/v1.2.0.zip';
const BETA_ZIP = 'https://github.com/Ethanyang9512/beta-studio/archive/refs/tags/v0.3.0.zip';

const PAGES = [
  '404.html',
  'about/index.html',
  'index.html',
  'llms.txt',
  'podcast/index.html',
  'robots.txt',
  'sitemap.xml',
  'works/alpha-kit/index.html',
  'works/beta-studio/index.html',
  'works/gamma-bot/index.html',
  'works/index.html',
];
const BLOG_PAGES = ['blog/feed.xml', 'blog/fixture-first-post/index.html', 'blog/index.html'];

// 夹具博客：文章在 content/blog/post.md，它的图片照导入工具的约定放在 content/blog/<slug>/
async function makeRoot({ withPost = false, held, episodeCount } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'site-test-root-'));
  await cp(join(SITE, 'assets'), join(root, 'assets'), { recursive: true });
  await cp(FIXTURE, root, { recursive: true });
  if (withPost) {
    await cp(POST, join(root, 'content/blog/post.md'));
    await cp(POST_FILES, join(root, 'content/blog/fixture-first-post'), { recursive: true });
  }
  if (held) {
    await writeFile(join(root, 'data/held.json'), JSON.stringify({ episodes: [], releases: [], posts: [], ...held }));
  }
  if (episodeCount !== undefined) {
    const file = join(root, 'data/podcast.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.podcast.episodeCount = episodeCount;
    await writeFile(file, JSON.stringify(data));
  }
  return root;
}

async function buildFrom(rootDir, options = {}) {
  const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));
  const result = await buildSite({ rootDir, outDir, ...options });
  return { rootDir, outDir, result, read: (p) => readFile(join(outDir, p), 'utf8') };
}

const build = async (rootOptions, options) => buildFrom(await makeRoot(rootOptions), options);

async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), `${rel}/`)));
    else files.push(rel);
  }
  return files.sort();
}

// 读页面只看语义（链接地址、文字内容、属性），不对整段标记做字面匹配：换皮加 class 不影响
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);
const textOf = (fragment) => decode(fragment.replace(/<[^>]*>/g, '')).trim();
const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attrsOf(m[0]));
const linksIn = (html) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ ...attrsOf(m[1]), text: textOf(m[2]) }));
const hrefsIn = (html) => linksIn(html).map((l) => l.href);
const metaOf = (html, name) => tagsOf(html, 'meta').find((m) => m.name === name)?.content;
const htmlFiles = (files) => files.filter((f) => f.endsWith('.html'));
const mainOf = (html) => html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const navOf = (html) => html.match(/<nav\b[\s\S]*?<\/nav>/)?.[0] ?? '';
const sectionAt = (html, id) => html.search(new RegExp(`<section\\b[^>]*\\bid="${id}"`));

function section(html, id) {
  const start = sectionAt(html, id);
  assert.ok(start >= 0, `没有 section#${id}`);
  return html.slice(start, html.indexOf('</section>', start));
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script\b[^>]*\btype="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  return JSON.parse(blocks[0][1]);
}

const zipBytes = (label) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`夹具压缩包 ${label}`)]);

test('build outputs exactly the listed pages plus assets', async () => {
  const rootDir = await makeRoot();
  // 隐藏文件（比如 Mac 的 .DS_Store）不该发布出去
  await writeFile(join(rootDir, 'assets/.DS_Store'), 'x');
  const { outDir, result } = await buildFrom(rootDir);

  const files = await listFiles(outDir);
  assert.deepEqual(files.filter((f) => !f.startsWith('assets/')), PAGES);
  assert.deepEqual([...result.pages].sort(), PAGES);

  const assets = (await listFiles(join(rootDir, 'assets'))).filter((f) => f !== '.DS_Store');
  assert.ok(assets.includes('site.css') && assets.includes('img/podcast-qr.svg'), assets.join());
  assert.deepEqual(files.filter((f) => f.startsWith('assets/')), assets.map((f) => `assets/${f}`));
  for (const f of assets) {
    assert.deepEqual(await readFile(join(outDir, 'assets', f)), await readFile(join(rootDir, 'assets', f)), f);
  }
});

test('build refuses a non-empty output directory', async (t) => {
  // 只写不删会让撤下的页面和旧下载包留在输出里，所以输出目录必须是空的或不存在（旧的由调用方先 trash）
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(String(url));
    return new Response(zipBytes(url));
  });
  const rootDir = await makeRoot();
  const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));
  await writeFile(join(outDir, 'old.html'), '上一次构建留下的文件');

  await assert.rejects(buildSite({ rootDir, outDir, withDownloads: true }), (err) => err.message === 'OUT_NOT_EMPTY');
  assert.deepEqual(await listFiles(outDir), ['old.html']);
  assert.deepEqual(fetched, []);

  // 不存在的目录照常新建
  const fresh = join(await mkdtemp(join(tmpdir(), 'site-test-out-')), 'nested', 'dist');
  const { pages } = await buildSite({ rootDir, outDir: fresh });
  assert.deepEqual([...pages].sort(), PAGES);
});

test('home page leads with the intro, then works, latest episode and recent updates', async () => {
  const { read } = await build();
  const html = await read('index.html');
  const body = html.slice(html.indexOf('<body'));

  assert.match(body, /Ethan/);
  const at = ['intro', 'works', 'latest-episode', 'updates'].map((id) => sectionAt(body, id));
  assert.ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `区块顺序不对：${at}`);

  const intro = section(body, 'intro');
  assert.match(textOf(intro), /夹具一句话介绍/);
  const entries = linksIn(intro).map((l) => `${l.href} ${l.text}`);
  assert.ok(entries.includes('works/ 看作品') && entries.includes('podcast/ 听播客'), entries.join(' | '));

  const works = textOf(section(body, 'works'));
  const names = ['Alpha Kit', 'Beta Studio', 'Gamma Bot'].map((n) => works.indexOf(n));
  assert.ok(names[0] >= 0 && names[0] < names[1] && names[1] < names[2], `作品顺序不对：${names}`);

  const latest = hrefsIn(section(body, 'latest-episode'));
  assert.ok(latest.includes(EP3.url) && !latest.includes(EP2.url), latest.join(' '));

  // 单集和版本按日期倒序合并（没有博客时一共 5 条）
  assert.deepEqual(hrefsIn(section(body, 'updates')), [EP3.url, 'works/alpha-kit/', EP2.url, 'works/beta-studio/', EP1.url]);
});

test('podcast page reports missing episodes honestly', async () => {
  const { read } = await build();
  const page = textOf(mainOf(await read('podcast/index.html')));
  assert.match(page, /共 5 期/);
  assert.deepEqual(hrefsIn(mainOf(await read('podcast/index.html'))).filter((h) => h.includes('/episode/')), [
    EP3.url,
    EP2.url,
    EP1.url,
  ]);
  // 少的不一定是较早的（撤下的可能是最新一期），所以只说没在本站列出
  assert.match(page, /另有 2 期未在本站列出，可在小宇宙收听全部/);
  assert.match(await read('llms.txt'), /另有 2 期未在本站列出，可在小宇宙收听全部/);
  assert.ok(hrefsIn(mainOf(await read('podcast/index.html'))).includes(PODCAST_URL));

  // 单集数等于来源期数时，不写那句话
  const full = textOf(mainOf(await (await build({ episodeCount: 3 })).read('podcast/index.html')));
  assert.match(full, /共 3 期/);
  assert.doesNotMatch(full, /另有/);
});

test('podcast page offers simple ways to listen', async () => {
  const { read } = await build();
  const html = await read('podcast/index.html');
  const page = mainOf(html);
  const links = linksIn(page);
  const textsFor = (href) => links.filter((l) => l.href === href).map((l) => l.text);

  // 每期标题直接链到小宇宙公开单集页；标题照原样显示，里面的标签不会变成真的标签
  assert.deepEqual(textsFor(EP2.url), ['Vol.02 夹具第二期']);
  assert.deepEqual(textsFor(EP3.url), ['Vol.03 夹具第三期 </script><b>注入</b> & "引号"']);
  assert.doesNotMatch(html, /<b>注入/);
  // 东八区的日期（第二期是 UTC 2 月 15 日 17:30，东八区已是 16 日）和时长
  assert.match(textOf(page), /2026-02-16/);
  assert.match(textOf(page), /1 小时 2 分钟/);

  assert.ok(textsFor(PODCAST_URL).includes('在小宇宙收听全部节目'), textsFor(PODCAST_URL).join(' | '));

  const qr = tagsOf(page, 'img').find((img) => img.src?.endsWith('podcast-qr.svg'));
  assert.ok(qr, '没有扫码图');
  assert.equal(qr.src, '../assets/img/podcast-qr.svg');
  for (const word of ['扫码', '小宇宙', '节目页']) assert.ok(qr.alt.includes(word), qr.alt);

  // 公众号只写名字，不加链接；不是每期都有文字版
  assert.match(textOf(page), /部分单集有文字版，发在公众号「二手国王」/);
  assert.ok(links.every((l) => !l.text.includes('二手国王')));

  // 不放 RSS 订阅
  assert.doesNotMatch(html, /rss|feed|\.xml/i);
});

test('every page names its build in a generator meta', async (t) => {
  const saved = process.env.GITHUB_SHA;
  t.after(() => {
    if (saved === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = saved;
  });
  const generators = async ({ outDir, read }) =>
    Promise.all(htmlFiles(await listFiles(outDir)).map(async (f) => metaOf(await read(f), 'generator')));

  process.env.GITHUB_SHA = 'a1b2c3d-fixture-sha';
  const fromEnv = await generators(await build());
  assert.equal(fromEnv.length, htmlFiles(PAGES).length);
  assert.deepEqual(new Set(fromEnv), new Set(['site-build a1b2c3d']));

  delete process.env.GITHUB_SHA;
  // 不是 git 仓库（系统临时目录）：写 dev
  assert.deepEqual(new Set(await generators(await build())), new Set(['site-build dev']));

  // 是 git 仓库：取 git rev-parse --short HEAD
  const rootDir = await makeRoot();
  const git = (...args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const head = git('rev-parse', '--short', 'HEAD');
  assert.match(head, /^[0-9a-f]{7,}$/);
  assert.deepEqual(new Set(await generators(await buildFrom(rootDir))), new Set([`site-build ${head}`]));
});

test('nav marks the current page and the current section', async () => {
  const { read } = await build();
  const current = async (f) =>
    linksIn(navOf(await read(f)))
      .filter((l) => l['aria-current'])
      .map((l) => `${l.text}=${l['aria-current']}`);
  // 栏目页本身是 page；作品详情页里“作品”只是所在栏目，不能说成当前页
  assert.deepEqual(await current('works/index.html'), ['作品=page']);
  assert.deepEqual(await current('works/alpha-kit/index.html'), ['作品=true']);
  assert.deepEqual(await current('index.html'), []);
});

test('404 page uses root paths', async () => {
  const { read } = await build();
  const refs = [...(await read('404.html')).matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.includes('/') && refs.includes('/assets/site.css'), refs.join(' '));
  for (const ref of refs) assert.match(ref, /^\/(?!\/)/, ref);
});

test('held episode is not rendered', async () => {
  // 不撤下时它在各处都有
  const shown = await build();
  for (const f of ['podcast/index.html', 'index.html', 'llms.txt']) assert.ok((await shown.read(f)).includes(EP3.eid), f);

  const { result, read } = await build({ held: { episodes: [EP3.eid] } });
  for (const f of result.pages) {
    const text = await read(f);
    assert.ok(!text.includes(EP3.eid) && !text.includes('夹具第三期'), f);
  }
  // 其余单集照常，首页的“最新一期”顺延
  assert.ok((await read('podcast/index.html')).includes(EP2.eid));
  assert.ok(hrefsIn(section(await read('index.html'), 'latest-episode')).includes(EP2.url));
});

test('episode listed as deleted at the source is not rendered', async () => {
  // deleted 是同步记下的小宇宙上删掉的单集：和 episodes 一样不上站
  const { result, read } = await build({ held: { deleted: [EP3.eid] } });
  for (const f of result.pages) {
    const text = await read(f);
    assert.ok(!text.includes(EP3.eid) && !text.includes('夹具第三期'), f);
  }
  assert.ok((await read('podcast/index.html')).includes(EP2.eid));
  assert.ok(hrefsIn(section(await read('index.html'), 'latest-episode')).includes(EP2.url));

  // 两份清单同时有时，两边的都不上站
  const both = await build({ held: { episodes: [EP3.eid], deleted: [EP2.eid] } });
  for (const f of both.result.pages) {
    const text = await both.read(f);
    assert.ok(!text.includes(EP3.eid) && !text.includes(EP2.eid), f);
  }
  assert.ok((await both.read('podcast/index.html')).includes(EP1.eid));
});

test('held release and post are not rendered', async () => {
  const { outDir, result, read } = await build({
    withPost: true,
    // 版本编号写 <repo>:<tag>（用冒号连接，免得看着像邮箱地址）
    held: { releases: ['beta-studio:v0.3.0'], posts: ['fixture-first-post'] },
  });
  for (const f of result.pages) {
    const text = await read(f);
    assert.ok(!text.includes('v0.3.0') && !text.includes('beta-studio-0.3.0') && !text.includes('夹具博客'), f);
  }
  // 撤下的文章连同它的图片都不发布
  assert.deepEqual((await listFiles(outDir)).filter((f) => f.startsWith('blog/')), []);
  // 版本撤下了，源码链接还在
  const betaLinks = hrefsIn(mainOf(await read('works/beta-studio/index.html')));
  assert.ok(betaLinks.includes('https://github.com/Ethanyang9512/beta-studio'));
  assert.ok(!betaLinks.some((h) => h.endsWith('.zip')), betaLinks.join(' '));
});

// held.json 原样写成 value：makeRoot 的 held 选项会补齐键，写不出缺键、null、顶层是数组这些情形
const setHeld = (rootDir, value) => writeFile(join(rootDir, 'data/held.json'), JSON.stringify(value));

test('malformed held.json fails the build instead of hiding nothing', async () => {
  // 手工往清单里加 eid 时写错了格式：不能当成“没撤下”（本该藏起来的那期会照样上站，还没人知道），要大声失败。
  // 抛出的错只带哪个键、该是什么类型
  const LIST = '字符串数组';
  const cases = [
    // 写成了字符串（不检查的话会被逐字遍历）
    [{ episodes: EP3.eid }, 'episodes', LIST],
    [{ releases: 'beta-studio:v0.3.0' }, 'releases', LIST],
    [{ posts: 'fixture-first-post' }, 'posts', LIST],
    [{ deleted: EP3.eid }, 'deleted', LIST],
    // null、对象、数字：不是数组
    [{ episodes: null }, 'episodes', LIST],
    [{ releases: {} }, 'releases', LIST],
    [{ posts: 3 }, 'posts', LIST],
    // 数组里混进了不是字符串的
    [{ episodes: [EP3.eid, 3] }, 'episodes', LIST],
    [{ deleted: [null] }, 'deleted', LIST],
    [{ posts: [['x']] }, 'posts', LIST],
    // 顶层不是对象
    [[EP3.eid], 'held.json', '对象'],
    [null, 'held.json', '对象'],
    [EP3.eid, 'held.json', '对象'],
  ];
  const rootDir = await makeRoot();
  for (const [held, key, expected] of cases) {
    await setHeld(rootDir, held);
    const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));

    await assert.rejects(
      buildSite({ rootDir, outDir }),
      (err) => err.message === 'HELD' && err.key === key && err.expected === expected,
      JSON.stringify(held),
    );
    assert.deepEqual(await readdir(outDir), [], '构建失败时什么都不写');
  }
});

test('held.json lists that are missing count as empty and unknown keys are ignored', async () => {
  // 旧格式（没有 deleted）、一个键都没有、多出不认识的键：都照常构建，什么都不撤下
  const rootDir = await makeRoot();
  for (const held of [{ episodes: [], releases: [], posts: [] }, {}, { note: 3, extra: 'x', more: [1] }]) {
    await setHeld(rootDir, held);
    const { read } = await buildFrom(rootDir);
    assert.ok((await read('podcast/index.html')).includes(EP3.eid), JSON.stringify(held));
  }
  // 缺 deleted 的旧格式，episodes 里的照样撤下；不认识的键不影响
  await setHeld(rootDir, { episodes: [EP3.eid], note: '别的键' });
  const { read } = await buildFrom(rootDir);
  assert.ok(!(await read('podcast/index.html')).includes(EP3.eid));
});

test('private work page has no download, GitHub link or ways to get it', async () => {
  const { read } = await build();
  const html = await read('works/gamma-bot/index.html');
  assert.match(textOf(mainOf(html)), /暂未开源/);
  // 状态只写在规格表里，不另起一块只有“暂未开源”四个字的“获取方式”，页头也没有跳过去的链接
  assert.equal(sectionAt(html, 'get'), -1);
  assert.doesNotMatch(textOf(mainOf(html)), /获取方式/);
  assert.ok(!hrefsIn(mainOf(html)).includes('#get'));
  assert.doesNotMatch(html, /github\.com/);
  assert.doesNotMatch(html, /\.zip|downloads\//);
  assert.doesNotMatch(textOf(mainOf(html)), /WorkBuddy|代码 MIT/);
});

test('work page shows only the ways to get it that exist, quickest first', async () => {
  const { read } = await build();

  const alphaMain = mainOf(await read('works/alpha-kit/index.html'));
  const alphaGet = section(alphaMain, 'get');
  const alphaText = textOf(alphaGet);
  assert.ok(hrefsIn(alphaGet).includes('https://github.com/Ethanyang9512/alpha-kit'));
  assert.ok(hrefsIn(alphaGet).includes(ALPHA_ZIP));
  // 先说要装好 Claude Code 再给命令；WorkBuddy 先说它是什么再列名字；最后才是看源码和下载源码包
  const order = [
    '装进 Claude Code',
    '先装好 Anthropic 的 AI 编程助手 Claude Code',
    '/plugin marketplace add Ethanyang9512/alpha-kit',
    '在 WorkBuddy 安装',
    'WorkBuddy 是腾讯的 AI 客户端',
    '夹具技能一',
    '在 GitHub 看源码',
    '下载源码包',
    '下载后照包里的 README 安装',
  ].map((s) => alphaText.indexOf(s));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `顺序不对：${order}`);
  assert.match(alphaText, /夹具技能一\s*（技能）/);
  assert.match(alphaText, /夹具专家团\s*（专家团）/);
  // 有专家团才提专家团在专家市场
  assert.match(alphaText, /专家团在专家市场里/);
  assert.ok(alphaText.includes('许可：代码 MIT、文档 CC BY 4.0'), alphaText);
  assert.deepEqual(tagsOf(alphaMain, 'img'), []); // visual.src 为 null 时不出图
  // 页头规格表旁：跳到本页获取方式的链接
  const alphaHead = alphaMain.slice(0, sectionAt(alphaMain, 'audience'));
  assert.ok(linksIn(alphaHead).some((l) => l.href === '#get' && l.text === '获取方式'), hrefsIn(alphaHead).join(' '));

  const betaMain = mainOf(await read('works/beta-studio/index.html'));
  const betaGet = section(betaMain, 'get');
  assert.ok(hrefsIn(betaGet).includes('https://github.com/Ethanyang9512/beta-studio'));
  assert.ok(hrefsIn(betaGet).includes(BETA_ZIP));
  assert.doesNotMatch(textOf(betaGet), /WorkBuddy|\/plugin|Claude Code/);
  // 只有一个许可证：写它的名字
  assert.match(textOf(betaGet), /许可：MIT$/);
  assert.deepEqual(
    tagsOf(betaMain, 'img').map((img) => [img.src, img.alt]),
    [['../../assets/img/fixture-beta.svg', '夹具示意图乙']],
  );
  // 示意图下面有看得见的图注（不只写在 alt 里）
  const figure = betaMain.match(/<figure class="work-visual">[\s\S]*?<\/figure>/)?.[0] ?? '';
  assert.equal(textOf(figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/)?.[1] ?? ''), '夹具图注乙：说清这张图讲什么。');
});

test('WorkBuddy is explained where it is listed; expert teams come up only when there is one', async () => {
  const definition = /WorkBuddy 是腾讯的 AI 客户端，技能在它的技能市场里/;
  const { read } = await build();
  // 作品列表页：汇总那一行下面就有一句定义
  const works = textOf(mainOf(await read('works/index.html')));
  assert.ok(works.indexOf('WorkBuddy 已公开 2 项') >= 0 && works.search(definition) > works.indexOf('WorkBuddy 已公开 2 项'), works);
  assert.match(works, /专家团在专家市场里/);

  // 只有技能、没有专家团：两处都不提专家团和专家市场
  const rootDir = await makeRoot();
  const file = join(rootDir, 'data/works.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  data[0].workbuddy.items = data[0].workbuddy.items.filter((i) => i.type === '技能');
  await writeFile(file, JSON.stringify(data));
  const skillsOnly = await buildFrom(rootDir);
  for (const page of ['works/index.html', 'works/alpha-kit/index.html']) {
    const text = textOf(mainOf(await skillsOnly.read(page)));
    assert.match(text, definition, page);
    assert.doesNotMatch(text, /专家团|专家市场/, page);
  }
});

test('open works state both licenses where they have two', async () => {
  const { read } = await build();
  for (const page of ['index.html', 'works/index.html', 'works/alpha-kit/index.html']) {
    assert.ok(textOf(mainOf(await read(page))).includes('已开源，代码 MIT、文档 CC BY 4.0'), page);
  }
  assert.match(textOf(mainOf(await read('works/beta-studio/index.html'))), /已开源，MIT 许可证/);
});

test('about page says where to find me, where to report problems and what this site is', async () => {
  const { read } = await build();
  const main = mainOf(await read('about/index.html'));
  const findMe = section(main, 'find-me');
  assert.equal(textOf(findMe.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)[1]), '在哪找到我');
  // 公众号没有链接：写明在微信里怎么找
  assert.match(textOf(findMe), /公众号\s*微信里搜索公众号「二手国王」/);
  assert.ok(linksIn(findMe).every((l) => !l.text.includes('二手国王')));
  // 工具有问题：到开源作品各自仓库的 Issue 页（暂未开源的不列）
  assert.match(textOf(findMe), /工具用着有问题：到对应的 GitHub 仓库提 Issue/);
  assert.deepEqual(
    hrefsIn(findMe).filter((h) => h.endsWith('/issues')),
    ['https://github.com/Ethanyang9512/alpha-kit/issues', 'https://github.com/Ethanyang9512/beta-studio/issues'],
  );
  // 这个网站：放什么、怎么更新、文字的许可
  const thisSite = textOf(section(main, 'this-site'));
  for (const fact of ['以后也放博客', '每天自动从小宇宙和 GitHub 同步一次', 'CC BY 4.0', '署名 Ethan']) {
    assert.ok(thisSite.includes(fact), `${fact}：${thisSite}`);
  }
  // 有了博客就不再说“以后”
  const withPost = textOf(section(mainOf(await (await build({ withPost: true })).read('about/index.html')), 'this-site'));
  assert.doesNotMatch(withPost, /以后也放博客/);
  assert.match(withPost, /博客/);
});

test('duration chart shows the shortest and longest episode as text', async () => {
  const { read } = await build();
  for (const page of ['index.html', 'podcast/index.html']) {
    assert.match(plainText(await read(page)), /最短 25 分钟 · 最长 1 小时 2 分钟/, page);
  }
});

test('listed words are kept on one line without changing the text', async () => {
  assert.equal(keep('一个给个人播客创作者'), '<span class="nobr">一个</span>给<span class="nobr">个人</span>播客创作者');
  assert.equal(keep('开源在 GitHub 上 & <b>'), '开源在 <span class="nobr">GitHub 上</span> &amp; &lt;b&gt;');
  assert.equal(keep('没有要包的词'), '没有要包的词');
  // 首页导语里的两个“一个”都包上了，读成纯文字还是原句
  const { read } = await build();
  const lead = (await read('index.html')).match(/<p class="hero__lead">([\s\S]*?)<\/p>/)[1];
  assert.equal((lead.match(/<span class="nobr">一个<\/span>/g) ?? []).length, 2);
  assert.equal(textOf(lead), '夹具简介：这里放我做的东西，一个给分析师，一个给创作者。');
});

test('with downloads the zips are saved and linked from the site', async (t) => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(String(url));
    return new Response(zipBytes(url), { status: 200 });
  });

  const { outDir, result, read } = await build({}, { withDownloads: true });

  assert.deepEqual(asked.sort(), [ALPHA_ZIP, BETA_ZIP].sort());
  assert.deepEqual(await readFile(join(outDir, 'downloads/alpha-kit-1.2.0.zip')), zipBytes(ALPHA_ZIP));
  assert.deepEqual(await readFile(join(outDir, 'downloads/beta-studio-0.3.0.zip')), zipBytes(BETA_ZIP));
  assert.deepEqual([...result.pages].sort(), PAGES);
  const get = section(mainOf(await read('works/alpha-kit/index.html')), 'get');
  assert.ok(hrefsIn(get).includes('../../downloads/alpha-kit-1.2.0.zip'), hrefsIn(get).join(' '));
  assert.ok(!get.includes('archive/refs/tags'));
});

test('a download that fails is skipped and the build goes on', async (t) => {
  // 作品仓库删了、转私有，或者一时连不上：跳过这个包、打印一行错误码（不带原文），那件作品页上不放下载按钮
  const marker = '夹具标记XYZ';
  const cases = [
    {
      fetch: async (url) =>
        String(url).includes('beta-studio') ? new Response(`Not Found ${marker}`, { status: 404 }) : new Response(zipBytes(url)),
      saved: ['alpha-kit-1.2.0.zip'],
      logged: ['E_DOWNLOAD beta-studio-0.3.0.zip 404'],
    },
    {
      fetch: async () => new Response(`<html>不是压缩包 ${marker}</html>`, { status: 200 }),
      saved: [],
      logged: ['E_NOT_ZIP alpha-kit-1.2.0.zip', 'E_NOT_ZIP beta-studio-0.3.0.zip'],
    },
    {
      fetch: async () => {
        throw new TypeError(`fetch failed ${marker}`);
      },
      saved: [],
      logged: ['E_DOWNLOAD alpha-kit-1.2.0.zip', 'E_DOWNLOAD beta-studio-0.3.0.zip'],
    },
  ];
  for (const { fetch, saved, logged } of cases) {
    const mockedFetch = t.mock.method(globalThis, 'fetch', fetch);
    const mockedLog = t.mock.method(console, 'error', () => {});

    const { outDir, result, read } = await build({}, { withDownloads: true });

    const lines = mockedLog.mock.calls.map((c) => c.arguments.join(' '));
    mockedFetch.mock.restore();
    mockedLog.mock.restore();
    assert.deepEqual(lines, logged);
    assert.deepEqual([...result.pages].sort(), PAGES);
    const files = await listFiles(outDir);
    assert.deepEqual(files.filter((f) => f.startsWith('downloads/')), saved.map((z) => `downloads/${z}`));
    for (const [page, zipName] of [['works/alpha-kit/index.html', 'alpha-kit-1.2.0.zip'], ['works/beta-studio/index.html', 'beta-studio-0.3.0.zip']]) {
      const links = hrefsIn(mainOf(await read(page)));
      const zipLinks = links.filter((h) => h.endsWith('.zip'));
      // 取到了的指向本站；取不到的既不指向本站，也不指向 GitHub 上取不到的地址
      assert.deepEqual(zipLinks, saved.includes(zipName) ? [`../../downloads/${zipName}`] : [], `${page}: ${zipLinks.join(' ')}`);
    }
  }
});

test('pages carry lang, title, description, canonical and JSON-LD', async () => {
  const types = {
    'index.html': 'Person',
    'about/index.html': 'Person',
    'works/index.html': 'CollectionPage',
    'works/alpha-kit/index.html': 'SoftwareSourceCode',
    'works/beta-studio/index.html': 'SoftwareSourceCode',
    'works/gamma-bot/index.html': 'CreativeWork',
    'podcast/index.html': 'PodcastSeries',
    'blog/index.html': 'Blog',
    'blog/fixture-first-post/index.html': 'BlogPosting',
  };
  const { outDir, read } = await build({ withPost: true });
  const pages = htmlFiles(await listFiles(outDir));
  assert.deepEqual(pages.filter((f) => f !== '404.html'), Object.keys(types).sort());

  for (const f of pages) {
    const html = await read(f);
    assert.match(html, /<html\b[^>]*\blang="zh-CN"/, f);
    assert.match(html, /<title>[^<]+<\/title>/, f);
    assert.ok(metaOf(html, 'description'), f);
    const canonical = tagsOf(html, 'link').find((l) => l.rel === 'canonical');
    if (f === '404.html') {
      // 404 在任意地址返回，不写 canonical，也不让搜索引擎收
      assert.equal(metaOf(html, 'robots'), 'noindex');
      assert.equal(canonical, undefined);
      assert.doesNotMatch(html, /ld\+json/);
      continue;
    }
    assert.equal(canonical?.href, `${SITE_URL}/${f.replace(/index\.html$/, '')}`, f);
    const ld = jsonLd(html);
    assert.equal(ld['@context'], 'https://schema.org', f);
    assert.equal(ld['@type'], types[f], f);
  }

  const podcast = jsonLd(await read('podcast/index.html'));
  assert.deepEqual(
    podcast.episode.map((e) => [e['@type'], e.url, e.duration]),
    [
      ['PodcastEpisode', EP3.url, 'PT25M'],
      ['PodcastEpisode', EP2.url, 'PT30M'],
      ['PodcastEpisode', EP1.url, 'PT1H1M40S'],
    ],
  );
  // 标题里的 </script> 不会提前结束 JSON-LD，解析回来和原文一样
  assert.equal(podcast.episode[0].name, 'Vol.03 夹具第三期 </script><b>注入</b> & "引号"');
  // 单集日期写东八区：只截日期也和页面上显示的日期一致（第二期 UTC 2 月 15 日 17:30 → 东八区 16 日）
  assert.deepEqual(
    podcast.episode.map((e) => e.datePublished),
    ['2026-03-15T20:00:00+08:00', '2026-02-16T01:30:00+08:00', '2026-01-15T20:00:00+08:00'],
  );
  assert.equal(jsonLd(await read('blog/fixture-first-post/index.html')).datePublished, '2026-03-01T00:00:00+08:00');
  assert.equal(jsonLd(await read('works/alpha-kit/index.html')).codeRepository, 'https://github.com/Ethanyang9512/alpha-kit');
  assert.equal(jsonLd(await read('works/gamma-bot/index.html')).codeRepository, undefined);
  // 代码和文档分开授权的，许可证是两个地址
  assert.deepEqual(jsonLd(await read('works/alpha-kit/index.html')).license, [
    'https://spdx.org/licenses/MIT.html',
    'https://creativecommons.org/licenses/by/4.0/',
  ]);
  assert.equal(jsonLd(await read('works/beta-studio/index.html')).license, 'https://spdx.org/licenses/MIT.html');
  assert.equal(jsonLd(await read('works/gamma-bot/index.html')).license, undefined);
});

test('every page except 404 has a share card with absolute addresses', async () => {
  // 链接发进飞书、Telegram、X 等软件时显示标题、简介和图
  const { outDir, read } = await build({ withPost: true });
  const IMAGE = `${SITE_URL}/assets/img/share.png`;
  const pages = htmlFiles(await listFiles(outDir));
  assert.ok(pages.includes('podcast/index.html') && pages.includes('about/index.html') && pages.includes('works/beta-studio/index.html'));
  for (const f of pages) {
    const html = await read(f);
    const metas = tagsOf(html, 'meta');
    const og = Object.fromEntries(metas.filter((m) => m.property?.startsWith('og:')).map((m) => [m.property, m.content]));
    if (f === '404.html') {
      assert.deepEqual(og, {}, '404 不放分享卡');
      assert.equal(metaOf(html, 'twitter:card'), undefined, f);
      continue;
    }
    const title = decode(/<title>([^<]*)<\/title>/.exec(html)[1]);
    const canonical = tagsOf(html, 'link').find((l) => l.rel === 'canonical').href;
    assert.deepEqual(
      og,
      {
        'og:type': f === 'blog/fixture-first-post/index.html' ? 'article' : 'website',
        'og:site_name': 'Ethan',
        'og:title': title,
        'og:description': metaOf(html, 'description'),
        'og:url': canonical,
        'og:image': IMAGE,
        'og:image:width': '1200',
        'og:image:height': '630',
        'og:image:alt': 'Ethan 的个人网站：作品、播客',
        'og:locale': 'zh_CN',
      },
      f,
    );
    assert.equal(metaOf(html, 'twitter:card'), 'summary_large_image', f);
    assert.match(canonical, /^https:\/\//, f); // 绝对地址
  }
  // 首页标题还是“Ethan”；属性值经过转义（文章标题里有 &）
  assert.equal(decode(/<title>([^<]*)<\/title>/.exec(await read('index.html'))[1]), 'Ethan');
  assert.match(await read('blog/fixture-first-post/index.html'), /<meta property="og:title" content="夹具博客：A &amp; B · Ethan">/);

  // 图：1200×630 的 PNG，在输出里，没有元数据，不超过 100 KB
  const png = await readFile(join(outDir, 'assets/img/share.png'));
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  assert.deepEqual(pngMetadata(png), []);
  assert.ok(png.length <= 100 * 1024, `share.png ${png.length} 字节，超过 100 KB`);
});

test('site loads nothing from other sites', async () => {
  const allowedLinkHosts = new Set(['github.com', 'www.xiaoyuzhoufm.com', 'fixture.example.invalid']);
  // 相对地址、根路径、本站绝对地址和内嵌的 data: 都不会连外站
  const internal = (url) =>
    !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url) || url.startsWith(`${SITE_URL}/`) || /^data:/i.test(url);

  for (const variant of [{}, { withPost: true }]) {
    const { outDir, read } = await build(variant);
    for (const f of await listFiles(outDir)) {
      if (!/\.(html|css|svg|xml|txt)$/.test(f)) continue;
      const text = await read(f);
      // 没有外部脚本，也不跑任何 JS：只允许 JSON-LD
      assert.doesNotMatch(text, /<script\b[^>]*\bsrc=/i, f);
      for (const m of text.matchAll(/<script\b([^>]*)>/gi)) assert.match(m[1], /type="application\/ld\+json"/, f);
      assert.doesNotMatch(text, /@import/i, f);
      for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]+)/gi)) assert.ok(internal(m[1]), `${f}: ${m[1]}`);
      for (const [, tag, attrs] of text.matchAll(/<([\w:-]+)\b([^>]*)>/g)) {
        for (const [, name, value] of attrs.matchAll(/\b(href|src|srcset|poster|data)="([^"]*)"/gi)) {
          if (tag.toLowerCase() === 'a') {
            assert.ok(internal(value) || allowedLinkHosts.has(new URL(value).host), `${f}: <a href="${value}">`);
          } else {
            assert.ok(internal(value), `${f}: <${tag} ${name}="${value}">`);
          }
        }
      }
    }
  }
});

test('work diagram scrolls sideways on phones, big enough that its smallest text is 14px', async () => {
  const { read } = await build();
  // 标记：图在能用键盘聚焦的容器里；提示在容器下面、图注上面，读屏不念；没有示意图的作品页没有这一块
  const beta = mainOf(await read('works/beta-studio/index.html'));
  const figure = beta.match(/<figure class="work-visual">[\s\S]*?<\/figure>/)?.[0] ?? '';
  const box = /<div class="work-visual__scroll"([^>]*)>([\s\S]*?)<\/div>/.exec(figure);
  assert.ok(box, '示意图没放进滑动容器');
  assert.equal(attrsOf(box[1]).tabindex, '0');
  assert.deepEqual(tagsOf(box[2], 'img').map((img) => img.src), ['../../assets/img/fixture-beta.svg']);
  const hint = /<p class="work-visual__hint"([^>]*)>([^<]*)<\/p>/.exec(figure);
  assert.equal(hint?.[2], '左右滑动看全图');
  assert.equal(attrsOf(hint[1])['aria-hidden'], 'true');
  const order = ['work-visual__scroll', 'work-visual__hint', '<figcaption'].map((part) => figure.indexOf(part));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `顺序不对：${order}`);
  assert.doesNotMatch(await read('works/alpha-kit/index.html'), /work-visual/);

  // 样式：图最小显示多宽，按各张示意图的画布宽和图里最小的字号算（14 / 最小字号 × 画布宽）
  let minWidth = 0;
  for (const name of ['workbench-architecture.svg', 'creator-studio-workflow.svg', 'dawn-architecture.svg']) {
    const svg = await readFile(join(SITE, 'assets/img', name), 'utf8');
    const canvas = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
    const smallest = Math.min(...[...svg.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])));
    minWidth = Math.max(minWidth, Math.ceil((14 * canvas) / smallest));
  }
  const css = await read('assets/site.css');
  const narrow = /@media \(max-width: ([\d.]+)px\) \{\s*\.work-visual__scroll \{ overflow-x: auto; \}\s*\.work-visual__scroll img \{ min-width: (\d+)px; \}\s*\.work-visual__hint \{ display: block; \}\s*\}/.exec(css);
  assert.ok(narrow, '窄屏的滑动容器、最小宽度和提示的样式不见了');
  assert.equal(Number(narrow[2]), minWidth, '图的最小宽度要让最小的字不小于 14px，也不要更宽');
  // 容器放得下最小宽度（视口 = 最小宽度加两边各 20px 页边）就不用滑动，窄屏的样式（含提示）到那里为止
  assert.equal(Number(narrow[1]), minWidth + 2 * 20 - 0.02);
  // 其余宽度提示是藏着的
  assert.match(css, /\.work-visual__hint \{\s*display: none;/);
  // 容器不比图宽（图最宽 600px）：宽屏上键盘聚焦的红框只框住图，不框一片空白
  assert.match(css, /\.work-visual img \{ width: 100%; max-width: 600px; \}\s*(?:\/\*[^*]*\*\/\s*)?\.work-visual__scroll \{ max-width: 600px; \}/);
});

test('on phones the numbers of the points list sit above the text and the text starts at the page edge', async () => {
  const css = await (await build()).read('assets/site.css');
  // 平板和电脑照旧左边一列编号
  assert.match(css, /\.point \{\s*display: grid;\s*grid-template-columns: 2\.5em minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 639\.98px\) \{\s*\.point \{ grid-template-columns: minmax\(0, 1fr\); row-gap: var\(--sp-1\); \}/);
});

test('Chinese quotes, middle dot, dash and ellipsis use local fonts and nothing is downloaded', async () => {
  // Helvetica 在前，这几个标点会落到它的窄字形上；单独交给本机的中文字体。只用 local()，不下载、不发请求
  const { read } = await build();
  const css = await read('assets/site.css');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const weights = faces.map((f) => /font-weight:\s*(\d+)/.exec(f)?.[1]);
  assert.deepEqual(weights, ['400', '500', '600'], '每个字重一条，粗体不靠合成');
  for (const face of faces) {
    assert.match(face, /font-family:\s*"CJK Punct"/);
    // 只管 “ ” ‘ ’ · — …
    assert.match(face, /unicode-range:\s*U\+2018-2019,\s*U\+201C-201D,\s*U\+00B7,\s*U\+2014,\s*U\+2026;/);
    const src = /src:([^;]*);/.exec(face)?.[1] ?? '';
    assert.doesNotMatch(src, /url\(/, '字体不能下载');
    assert.match(src, /^\s*local\("[^"]+"\)(,\s*local\("[^"]+"\))*\s*$/);
  }
  // 只写字体族名（"PingFang SC"）的 local() 在 Chrome 里找不到字体，要写 PostScript 名
  const first = (face) => /local\("([^"]+)"\)/.exec(face)[1];
  assert.deepEqual(faces.map(first), ['PingFangSC-Regular', 'PingFangSC-Medium', 'PingFangSC-Semibold']);
  // 放在正文字体栈最前面；等宽字体栈不动
  assert.match(css, /--font-sans:\s*"CJK Punct",\s*"Helvetica Neue",\s*Helvetica/);
  assert.doesNotMatch(/--font-mono:[^;]*;/.exec(css)[0], /CJK Punct/);
});

test('llms.txt keeps every link intact', async () => {
  const llms = await (await build({ withPost: true })).read('llms.txt');
  // 标题里的方括号要转义，不然 Markdown 链接会断
  assert.ok(llms.includes(`- [Vol.01 夹具第一期 \\[上\\]](${EP1.url}): `), llms);
  const items = llms.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(items.length > 0);
  for (const line of items) assert.match(line, /^- \[(?:\\.|[^\\\]])*\]\([^\s)]+\): /, line);
});

// 不引依赖的 XML 检查：一个根元素、标签成对、文字里没有裸的 & 和 <
function assertWellFormedXml(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  const stack = [];
  let roots = 0;
  for (const token of xml.slice(xml.indexOf('?>') + 2).split(/(<[^>]*>)/)) {
    if (token.startsWith('<')) {
      const m = token.match(/^<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>$/);
      assert.ok(m, `标签写坏了：${token}`);
      const [, closing, name, , selfClosing] = m;
      if (closing) assert.equal(stack.pop(), name);
      else {
        if (stack.length === 0) roots += 1;
        if (!selfClosing) stack.push(name);
      }
    } else {
      assert.doesNotMatch(token, /&(?!(amp|lt|gt|quot|apos|#\d+);)/, `裸的 &：${token}`);
      if (stack.length === 0) assert.match(token, /^\s*$/, `根元素外有文字：${token}`);
    }
  }
  assert.equal(stack.length, 0);
  assert.equal(roots, 1);
}

test('blog appears only when there are posts', async () => {
  const none = await build();
  assert.doesNotMatch(await none.read('index.html'), /博客/);
  assert.doesNotMatch(await none.read('llms.txt'), /## 博客/);

  const { outDir, result, read } = await build({ withPost: true });
  assert.deepEqual([...result.pages].sort(), [...PAGES, ...BLOG_PAGES].sort());
  for (const f of htmlFiles(await listFiles(outDir))) {
    assert.ok(linksIn(navOf(await read(f))).some((l) => l.text === '博客'), f);
  }

  const post = mainOf(await read('blog/fixture-first-post/index.html'));
  assert.equal(textOf(post.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)[1]), '夹具博客：A & B');
  assert.match(post, /<strong>加粗<\/strong>/);
  assert.match(textOf(post), /2026-03-01/);
  assert.ok(hrefsIn(mainOf(await read('blog/index.html'))).includes('fixture-first-post/'));
  assert.ok((await read('sitemap.xml')).includes(`<loc>${SITE_URL}/blog/fixture-first-post/</loc>`));
  assert.ok((await read('llms.txt')).includes(`## 博客\n\n- [夹具博客：A & B](${SITE_URL}/blog/fixture-first-post/)`));
  // 最近更新里有博客，合并后只取前 5 条
  assert.deepEqual(hrefsIn(section(await read('index.html'), 'updates')), [
    EP3.url,
    'blog/fixture-first-post/',
    'works/alpha-kit/',
    EP2.url,
    'works/beta-studio/',
  ]);

  // feed.xml 是合法的 RSS 2.0
  const feed = await read('blog/feed.xml');
  assertWellFormedXml(feed);
  assert.match(feed, /<rss version="2\.0"[^>]*>\s*<channel>/);
  const head = feed.slice(feed.indexOf('<channel>'), feed.indexOf('<item>'));
  for (const tag of ['title', 'link', 'description']) assert.match(head, new RegExp(`<${tag}>[^<]+</${tag}>`), tag);
  const items = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  assert.equal(items.length, 1);
  assert.match(items[0], /<title>夹具博客：A &amp; B<\/title>/);
  assert.ok(items[0].includes(`<link>${SITE_URL}/blog/fixture-first-post/</link>`));
  assert.ok(items[0].includes(`<guid isPermaLink="true">${SITE_URL}/blog/fixture-first-post/</guid>`));
  // 文章只写了日期：按东八区当天零点，也就是 UTC 前一天 16 点
  assert.match(items[0], /<pubDate>Sat, 28 Feb 2026 16:00:00 GMT<\/pubDate>/);
});

test('post images are published next to the post', async () => {
  // 导入工具的约定：图片放 content/blog/<slug>/，正文写 ![](x.png)；生成器原样复制到 blog/<slug>/
  const { outDir, read } = await build({ withPost: true });
  assert.deepEqual(
    (await listFiles(outDir)).filter((f) => f.startsWith('blog/fixture-first-post/')),
    ['blog/fixture-first-post/figure.png', 'blog/fixture-first-post/index.html'],
  );
  assert.deepEqual(await readFile(join(outDir, 'blog/fixture-first-post/figure.png')), await readFile(FIGURE));
  const imgs = tagsOf(mainOf(await read('blog/fixture-first-post/index.html')), 'img');
  assert.deepEqual(imgs.map((img) => [img.src, img.alt]), [['figure.png', '夹具示意图']]);

  // 文章目录里的文件和生成的页面重名：构建失败，不悄悄覆盖
  const rootDir = await makeRoot({ withPost: true });
  await writeFile(join(rootDir, 'content/blog/fixture-first-post/index.html'), '<p>重名</p>');
  await assert.rejects(buildFrom(rootDir), (err) => err.code === 'ERR_FS_CP_EEXIST');
});

test('two posts with the same slug fail the build', async () => {
  // 同一个 slug 会写到同一个目录，后一篇会悄悄盖掉前一篇
  const rootDir = await makeRoot();
  await cp(POST, join(rootDir, 'content/blog/a.md'));
  await cp(POST, join(rootDir, 'content/blog/b.md'));

  await assert.rejects(buildFrom(rootDir), (err) => err.message === 'BAD_POST' && err.file === 'b.md');
});

// 页面要加载的本地文件：<link href>、<img src/srcset>、<source srcset>，以及样式表里 url() 引用的字体和图片。
// 外站地址、data: 和 canonical 这类绝对地址不算（外站资源另有测试拦着）。
const ORIGIN = 'https://weight.invalid';
function localRefs(text, fromUrl, kind) {
  const urls = [];
  if (kind === 'html') {
    for (const [, tag, attrs] of text.matchAll(/<(link|img|source)\b([^>]*)>/gi)) {
      const a = attrsOf(attrs);
      if (tag.toLowerCase() === 'link' && a.href) urls.push(a.href);
      if (a.src) urls.push(a.src);
      if (a.srcset) urls.push(...a.srcset.split(',').map((s) => s.trim().split(/\s+/)[0]));
    }
  } else {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]+)/gi)) urls.push(m[1]);
  }
  return urls
    .filter((u) => u && !/^data:/i.test(u))
    .map((u) => new URL(u, fromUrl))
    .filter((u) => u.origin === ORIGIN)
    .map((u) => decodeURIComponent(u.pathname).slice(1));
}

test('page weight: stylesheet and home page stay small', async () => {
  const { outDir, read } = await build();
  const cssBytes = (await stat(join(outDir, 'assets/site.css'))).size;
  assert.ok(cssBytes <= 40 * 1024, `assets/site.css ${cssBytes} 字节，超过 40 KB`);

  // 首页 HTML + 它引用的本地样式、图片、字体（懒加载的也算），按未压缩字节相加
  const files = new Set(['index.html']);
  for (const ref of localRefs(await read('index.html'), `${ORIGIN}/index.html`, 'html')) files.add(ref);
  for (const f of [...files].filter((f) => f.endsWith('.css'))) {
    for (const ref of localRefs(await read(f), `${ORIGIN}/${f}`, 'css')) files.add(ref);
  }
  assert.ok(files.has('assets/site.css'), [...files].join(' '));
  let total = 0;
  for (const f of files) total += (await stat(join(outDir, f))).size;
  assert.ok(total <= 300 * 1024, `首页合计 ${total} 字节，超过 300 KB：${[...files].join(' ')}`);
});

// 只读文字的读者（抓网页的 AI、只取文字的工具、读屏）不看样式：并排的元信息之间要有真实的空格或分隔符，
// 不能只靠样式的间距分开，否则会读到“2026-09-2222 分钟”这样黏连的字。读屏还会跳过 aria-hidden 的分隔符，
// 所以再查一遍去掉它们的版本。
const GLUED = [
  [/[\p{L}\p{N}]\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}[\p{L}\p{N}]/u, '日期和前后的字连在一起'],
  [/[\p{L}\p{N}]v\d+(?:\.\d+)+|v\d+(?:\.\d+)+[\p{L}\p{N}]/u, '版本号和前后的字连在一起'],
  [/\p{Script=Han}\d|\d\p{Script=Han}/u, '汉字和数字连在一起'],
  [/\p{Script=Han}[A-Za-z]|[A-Za-z]\p{Script=Han}/u, '汉字和拉丁字母连在一起'],
  [/单集时长按期排列|收听全部节目全部单集/, '两段并排的文字连成一句'],
];
const withoutHidden = (html) => html.replace(/<(span|p)\b[^>]*\baria-hidden="true"[^>]*>[^<]*<\/\1>/g, '');

test('read as plain text, side-by-side words do not run together', async () => {
  const { read } = await build();
  const pages = ['index.html', 'podcast/index.html', 'works/index.html', 'works/alpha-kit/index.html', 'works/beta-studio/index.html', 'works/gamma-bot/index.html', 'about/index.html'];
  for (const page of pages) {
    const html = await read(page);
    for (const [reader, text] of [['纯文字', plainText(html)], ['读屏', plainText(withoutHidden(html))]]) {
      for (const [re, what] of GLUED) {
        const m = re.exec(text);
        assert.equal(m?.[0] ?? null, null, `${page}（${reader}）${what}：${m ? text.slice(Math.max(0, m.index - 12), m.index + 16) : ''}`);
      }
    }
  }
  // 首页最新一期：日期和时长之间有空格
  assert.match(plainText(await read('index.html')), /2026-03-15 25 分钟/);
});

// 按字节找图片里的元数据，不加依赖。JPEG：SOS 之前的 APP1 段（Exif、XMP 都放在这里）；
// PNG：eXIf、tEXt、iTXt、zTXt 块。返回找到的段名或块名。
function jpegMetadata(buf) {
  assert.ok(buf[0] === 0xff && buf[1] === 0xd8, '不是 JPEG');
  const found = [];
  let i = 2;
  while (i + 1 < buf.length) {
    assert.equal(buf[i], 0xff, `JPEG 段头不对（第 ${i} 字节）`);
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // 填充字节
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // 后面是图像数据，或文件结束
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // 没有长度的独立标记
      continue;
    }
    if (marker === 0xe1) found.push('APP1');
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return found;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngMetadata(buf) {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), '不是 PNG');
  const found = [];
  for (let i = 8; i + 8 <= buf.length; ) {
    const type = buf.toString('latin1', i + 4, i + 8);
    if (['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) found.push(type);
    if (type === 'IEND') break;
    i += 12 + buf.readUInt32BE(i);
  }
  return found;
}

const jpegWith = (...segments) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...segments.map(([marker, body]) => {
      const head = Buffer.from([0xff, marker, 0, 0]);
      head.writeUInt16BE(body.length + 2, 2);
      return Buffer.concat([head, body]);
    }),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xe1, 0xff, 0xd9]), // 图像数据里碰巧出现的字节不算
  ]);
const pngWith = (...types) =>
  Buffer.concat([
    PNG_SIGNATURE,
    ...[...types, 'IEND'].map((type) => {
      const body = Buffer.from('k\0v');
      const chunk = Buffer.alloc(12 + body.length);
      chunk.writeUInt32BE(body.length, 0);
      chunk.write(type, 4, 'latin1');
      body.copy(chunk, 8);
      return chunk;
    }),
  ]);

test('no image metadata in published images', async () => {
  // 检查器本身认得出元数据（手造的字节）
  assert.deepEqual(jpegMetadata(jpegWith([0xe0, Buffer.from('JFIF\0')], [0xdb, Buffer.alloc(4)])), []);
  assert.deepEqual(jpegMetadata(jpegWith([0xe0, Buffer.from('JFIF\0')], [0xe1, Buffer.from('Exif\0\0')])), ['APP1']);
  assert.deepEqual(jpegMetadata(jpegWith([0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0')])), ['APP1']);
  assert.deepEqual(pngMetadata(pngWith('IHDR', 'IDAT')), []);
  assert.deepEqual(pngMetadata(pngWith('IHDR', 'tEXt', 'eXIf', 'IDAT', 'iTXt', 'zTXt')), ['tEXt', 'eXIf', 'iTXt', 'zTXt']);

  // 会发布出去的图片：assets/ 下全部，以及博客文章目录 content/ 下全部
  const images = [];
  for (const dir of ['assets', 'content']) {
    for (const f of await listFiles(join(SITE, dir))) {
      if (/\.(jpe?g|png)$/i.test(f)) images.push(`${dir}/${f}`);
    }
  }
  for (const f of images) {
    const buf = await readFile(join(SITE, f));
    assert.deepEqual(/\.png$/i.test(f) ? pngMetadata(buf) : jpegMetadata(buf), [], f);
  }
});

function runBuild(args) {
  const env = { ...process.env };
  delete env.NODE_USE_ENV_PROXY; // 测试只连本机
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUILD, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
  });
}

test('cli builds into --out', async () => {
  const rootDir = await makeRoot();
  const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));

  const r = await runBuild(['--root', rootDir, '--out', outDir, '--preview']);

  assert.equal(r.code, 0, r.all);
  assert.deepEqual((await listFiles(outDir)).filter((f) => !f.startsWith('assets/')), PAGES);
  assert.ok(hrefsIn(await readFile(join(outDir, 'index.html'), 'utf8')).includes('works/index.html'));
});

test('cli refuses a non-empty --out with only an error code', async () => {
  const rootDir = await makeRoot();
  const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));
  await writeFile(join(outDir, 'old.html'), '上一次构建留下的文件');

  const r = await runBuild(['--root', rootDir, '--out', outDir]);

  assert.equal(r.code, 1);
  assert.equal(r.all.trim(), 'E_OUT_NOT_EMPTY');
  assert.deepEqual(await listFiles(outDir), ['old.html']);
});

test('cli fails on a malformed held.json and prints only the key and the type', async () => {
  // 清单写成了字符串、或顶层不是对象：构建失败（部署随之跳过，线上保持上一版）。只打印哪个键、该是什么，不带值
  const marker = '夹具标记XYZ';
  const rootDir = await makeRoot();
  for (const [held, expected] of [
    [{ episodes: marker }, 'E_HELD episodes 应为字符串数组'],
    [[marker], 'E_HELD held.json 应为对象'],
  ]) {
    await setHeld(rootDir, held);
    const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));

    const r = await runBuild(['--root', rootDir, '--out', outDir]);

    assert.equal(r.code, 1);
    assert.equal(r.all.trim(), expected);
    assert.ok(!r.all.includes(marker));
    assert.deepEqual(await listFiles(outDir), []);
  }
});

test('cli skips a download it cannot get and prints only an error code', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/alpha.zip') {
      res.writeHead(200);
      res.end(zipBytes('alpha'));
    } else {
      res.writeHead(404);
      res.end('Not Found 夹具标记XYZ');
    }
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const rootDir = await makeRoot();
  const file = join(rootDir, 'data/releases.json');
  const releases = JSON.parse(await readFile(file, 'utf8'));
  releases.repos['alpha-kit'].zipUrl = `${base}/alpha.zip`;
  releases.repos['beta-studio'].zipUrl = `${base}/missing.zip`;
  await writeFile(file, JSON.stringify(releases));
  const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));

  const r = await runBuild(['--root', rootDir, '--out', outDir, '--with-downloads']);

  // 构建照常完成：取不到的那个包只打印一行错误码，不带服务器回的原文
  assert.equal(r.code, 0, r.all);
  assert.equal(r.stderr, 'E_DOWNLOAD beta-studio-0.3.0.zip 404\n');
  assert.equal(r.stdout, `构建完成：${PAGES.length} 个页面\n`);
  assert.ok(!r.all.includes('夹具标记XYZ'));
  assert.deepEqual((await listFiles(outDir)).filter((f) => f.startsWith('downloads/')), ['downloads/alpha-kit-1.2.0.zip']);
  const zipLinks = async (page) =>
    hrefsIn(mainOf(await readFile(join(outDir, page), 'utf8'))).filter((h) => h.endsWith('.zip'));
  assert.deepEqual(await zipLinks('works/alpha-kit/index.html'), ['../../downloads/alpha-kit-1.2.0.zip']);
  assert.deepEqual(await zipLinks('works/beta-studio/index.html'), []);
});
