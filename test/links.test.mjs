import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../build.mjs';

// 夹具站点 = 真实 assets/ + test/fixtures/site/ 的手写假数据（不读真实 data/）。临时目录由系统清理。
const SITE = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/site/', import.meta.url));
const POST = fileURLToPath(new URL('./fixtures/post.md', import.meta.url));
const POST_FILES = fileURLToPath(new URL('./fixtures/fixture-first-post/', import.meta.url));

const EPISODE_URLS = ['3', '2', '1'].map((n) => `https://www.xiaoyuzhoufm.com/episode/fe000000000000000000000${n}`);
const WORK_PAGES = ['works/alpha-kit/index.html', 'works/beta-studio/index.html', 'works/gamma-bot/index.html'];
const ORIGIN = 'https://crawl.invalid';

async function buildFixture({ preview = false, withPost = true } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'site-test-root-'));
  await cp(join(SITE, 'assets'), join(rootDir, 'assets'), { recursive: true });
  await cp(FIXTURE, rootDir, { recursive: true });
  if (withPost) {
    // 文章里的图片照约定放在 content/blog/<slug>/，遍历时检查页面里的 <img> 指到它
    await cp(POST, join(rootDir, 'content/blog/post.md'));
    await cp(POST_FILES, join(rootDir, 'content/blog/fixture-first-post'), { recursive: true });
  }
  const outDir = await mkdtemp(join(tmpdir(), 'site-test-out-'));
  const { pages } = await buildSite({ rootDir, outDir, preview });
  return { outDir, pages };
}

// 页面里的引用：<a href> 能点进去；<link href>、<img src> 这些是要加载的资源
function refs(html) {
  const found = [];
  for (const [, tag, attrs] of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    for (const [, url] of attrs.matchAll(/\b(?:href|src)="([^"]*)"/g)) found.push({ tag: tag.toLowerCase(), url: url.replaceAll('&amp;', '&') });
  }
  return found;
}

function fileFor(url) {
  const path = decodeURIComponent(url.pathname).slice(1);
  return path === '' || path.endsWith('/') ? `${path}index.html` : path;
}

// 从首页按 href 广度遍历。depth：从首页点几次到这一页；external：外链 → 出现它的页面最少要点几次
async function crawl(outDir) {
  const depth = new Map([['index.html', 0]]);
  const queue = ['index.html'];
  const broken = [];
  const external = new Map();
  const internal = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const base = new URL(file, `${ORIGIN}/`);
    for (const { tag, url } of refs(await readFile(join(outDir, file), 'utf8'))) {
      const target = new URL(url, base);
      if (target.origin !== ORIGIN) {
        if (tag === 'a' && !external.has(target.href)) external.set(target.href, depth.get(file));
        continue;
      }
      internal.push({ file, url, pathname: target.pathname });
      const targetFile = fileFor(target);
      if (!existsSync(join(outDir, targetFile))) broken.push(`${file}: ${url}`);
      else if (tag === 'a' && targetFile.endsWith('.html') && !depth.has(targetFile)) {
        depth.set(targetFile, depth.get(file) + 1);
        queue.push(targetFile);
      }
    }
  }
  return { depth, broken, external, internal };
}

test('every internal link points to a built file', async () => {
  for (const options of [{ withPost: false }, { withPost: true }, { preview: true }]) {
    const { outDir, pages } = await buildFixture(options);
    const { depth, broken } = await crawl(outDir);
    assert.deepEqual(broken, [], JSON.stringify(options));
    // 除了 404，每一页都能从首页点到
    const unreachable = pages.filter((p) => p.endsWith('.html') && p !== '404.html' && !depth.has(p));
    assert.deepEqual(unreachable, [], JSON.stringify(options));
  }
});

test('works and podcast pages are within 2 clicks', async () => {
  const { depth } = await crawl((await buildFixture()).outDir);
  for (const page of [...WORK_PAGES, 'podcast/index.html']) assert.ok(depth.get(page) <= 2, `${page}: ${depth.get(page)}`);
});

test('every episode link is on a page within 2 clicks', async () => {
  // 第 3 次点击到小宇宙
  const { external } = await crawl((await buildFixture()).outDir);
  for (const url of EPISODE_URLS) assert.ok(external.get(url) <= 2, `${url}: ${external.get(url)}`);
});

test('preview links name their files', async () => {
  // 私密预览的静态托管不一定认目录地址，所以每个站内链接都要写到文件
  const { internal } = await crawl((await buildFixture({ preview: true })).outDir);
  assert.ok(internal.length > 0);
  assert.deepEqual(
    internal.filter((r) => r.pathname.endsWith('/')).map((r) => `${r.file}: ${r.url}`),
    [],
  );
});

test('404 page links resolve from the site root', async () => {
  // Pages 在任意深度的地址上返回 404.html
  const { outDir } = await buildFixture();
  const local = refs(await readFile(join(outDir, '404.html'), 'utf8')).filter(({ url }) => url.startsWith('/'));
  assert.ok(local.length >= 3, local.map((r) => r.url).join(' '));
  for (const { url } of local) {
    assert.ok(existsSync(join(outDir, fileFor(new URL(url, `${ORIGIN}/deep/missing/page/`)))), url);
  }
});
