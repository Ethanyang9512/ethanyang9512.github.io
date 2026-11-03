import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用本机的假 GitHub API（GITHUB_API_URL 指过去），不连外网。临时目录由系统清理。
const SYNC = fileURLToPath(new URL('../scripts/sync-releases.mjs', import.meta.url));

const RELEASES = {
  // 假仓库的最新版本：字段照 GitHub API，值是编的
  '/repos/Ethanyang9512/demo-tool/releases/latest': {
    tag_name: 'v1.2.3',
    name: '夹具版本 v1.2.3',
    published_at: '2026-10-26T08:00:00Z',
    draft: false,
    prerelease: false,
    body: '发布说明（夹具）',
    author: { login: 'fixture-bot' },
    assets: [],
    zipball_url: 'https://api.example.invalid/zipball/v1.2.3',
  },
  // tag 会拼进下载地址和文件名，怪写法要拒收
  '/repos/Ethanyang9512/odd-tool/releases/latest': {
    tag_name: '../escape',
    name: null,
    published_at: '2026-10-26T08:00:00Z',
  },
};

// 仓库本身的接口（最新版本接口 404 之后才会查）：没列出的仓库回 404
const REPOS = {
  // 仓库在，只是还没有任何 Release
  '/repos/Ethanyang9512/fresh-tool': 200,
  // 最新版本接口 404，查仓库又出错：不能当成“暂无版本”
  '/repos/Ethanyang9512/flaky-tool': 500,
};

async function fakeGitHub(t) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    const release = RELEASES[req.url];
    const status = release ? 200 : (REPOS[req.url] ?? 404);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(release ?? (status === 200 ? { name: 'repo' } : { message: 'Not Found' })));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

async function makeDataDir(works, releasesJson) {
  const dir = await mkdtemp(join(tmpdir(), 'site-test-'));
  await writeFile(join(dir, 'works.json'), JSON.stringify(works));
  if (releasesJson !== undefined) await writeFile(join(dir, 'releases.json'), releasesJson);
  return dir;
}

function runSync(dataDir, env) {
  const childEnv = { ...process.env };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GITHUB_API_URL;
  Object.assign(childEnv, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNC, '--data-dir', dataDir], { env: childEnv });
    let all = '';
    child.stdout.on('data', (d) => (all += d));
    child.stderr.on('data', (d) => (all += d));
    child.on('close', (code) => resolve({ code, all }));
  });
}

const WORKS = [
  { slug: 'demo', repo: 'demo-tool', status: 'open-source' },
  { slug: 'private-thing', repo: null, status: 'private' },
];

test('releases sync records tag, zip url and zip name', async (t) => {
  const api = await fakeGitHub(t);
  const dir = await makeDataDir(WORKS);

  const r = await runSync(dir, { GITHUB_API_URL: api.url, GITHUB_TOKEN: 'fake-token-123' });

  assert.equal(r.code, 0, r.all);
  assert.equal(r.all, 'demo-tool v1.2.3\n');
  const saved = JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['checkedAt', 'repos']);
  assert.match(saved.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(saved.repos, {
    'demo-tool': {
      tag: 'v1.2.3',
      name: '夹具版本 v1.2.3',
      publishedAt: '2026-10-26T08:00:00.000Z',
      zipUrl: 'https://github.com/Ethanyang9512/demo-tool/archive/refs/tags/v1.2.3.zip',
      zipName: 'demo-tool-1.2.3.zip',
    },
  });
  // 有 GITHUB_TOKEN 就带上；没有仓库的作品不去查
  assert.deepEqual(api.seen, [{ url: '/repos/Ethanyang9512/demo-tool/releases/latest', authorization: 'Bearer fake-token-123' }]);
});

test('releases sync leaves file untouched when nothing changed', async (t) => {
  const api = await fakeGitHub(t);
  const dir = await makeDataDir(WORKS);
  assert.equal((await runSync(dir, { GITHUB_API_URL: api.url })).code, 0);
  const first = await readFile(join(dir, 'releases.json'), 'utf8');

  const r = await runSync(dir, { GITHUB_API_URL: api.url });

  assert.equal(r.code, 0, r.all);
  assert.equal(await readFile(join(dir, 'releases.json'), 'utf8'), first);
});

test('releases sync failure prints only error code', async (t) => {
  const api = await fakeGitHub(t);
  const before = '{\n  "checkedAt": "2026-01-01T00:00:00.000Z",\n  "repos": {}\n}\n';
  for (const [repo, code] of [
    ['missing-tool', 'E_REPO_GONE missing-tool'],
    ['flaky-tool', 'E_FETCH 500'],
    ['odd-tool', 'E_PARSE'],
  ]) {
    const dir = await makeDataDir([{ slug: repo, repo, status: 'open-source' }], before);

    const r = await runSync(dir, { GITHUB_API_URL: api.url });

    assert.equal(r.code, 1);
    assert.equal(r.all.trim(), code);
    assert.equal(await readFile(join(dir, 'releases.json'), 'utf8'), before);
  }
  // 没有 GITHUB_TOKEN 就不带认证头
  assert.ok(api.seen.length > 0);
  assert.ok(api.seen.every((s) => s.authorization === undefined));
});

test('releases sync fails with E_REPO_GONE when a work repo itself is gone', async (t) => {
  // 作品仓库删了或转成私有：最新版本接口和仓库接口都回 404。不能当成“暂无版本”悄悄过去，
  // 要让这次运行标红，提醒人去改 works.json；别的仓库这次也不写，releases.json 一个字节都不动
  const api = await fakeGitHub(t);
  const before = `${JSON.stringify(
    {
      checkedAt: '2026-01-01T00:00:00.000Z',
      repos: {
        'missing-tool': {
          tag: 'v0.1.0',
          name: null,
          publishedAt: '2026-01-01T00:00:00.000Z',
          zipUrl: 'https://github.com/Ethanyang9512/missing-tool/archive/refs/tags/v0.1.0.zip',
          zipName: 'missing-tool-0.1.0.zip',
        },
      },
    },
    null,
    2,
  )}\n`;
  const dir = await makeDataDir([...WORKS, { slug: 'gone', repo: 'missing-tool', status: 'open-source' }], before);

  const r = await runSync(dir, { GITHUB_API_URL: api.url });

  assert.equal(r.code, 1);
  assert.equal(r.all, 'E_REPO_GONE missing-tool\n');
  assert.equal(await readFile(join(dir, 'releases.json'), 'utf8'), before);
  assert.deepEqual(
    api.seen.map((s) => s.url),
    [
      '/repos/Ethanyang9512/demo-tool/releases/latest',
      '/repos/Ethanyang9512/missing-tool/releases/latest',
      '/repos/Ethanyang9512/missing-tool',
    ],
  );
});

const WORKS_WITH_FRESH = [...WORKS, { slug: 'fresh', repo: 'fresh-tool', status: 'open-source' }];

test('releases sync records a repo without any release as no version, not an error', async (t) => {
  const api = await fakeGitHub(t);
  const dir = await makeDataDir(WORKS_WITH_FRESH);

  const r = await runSync(dir, { GITHUB_API_URL: api.url });

  assert.equal(r.code, 0, r.all);
  assert.equal(r.all, 'demo-tool v1.2.3\nfresh-tool 无版本\n');
  // 没有版本的仓库不记：页面上就没有版本号和下载按钮
  const saved = JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.repos), ['demo-tool']);
  // 最新版本接口 404 之后，才去查仓库本身在不在
  assert.deepEqual(
    api.seen.map((s) => s.url),
    [
      '/repos/Ethanyang9512/demo-tool/releases/latest',
      '/repos/Ethanyang9512/fresh-tool/releases/latest',
      '/repos/Ethanyang9512/fresh-tool',
    ],
  );
});

test('releases sync leaves file untouched when a repo still has no release', async (t) => {
  const api = await fakeGitHub(t);
  const dir = await makeDataDir(WORKS_WITH_FRESH);
  assert.equal((await runSync(dir, { GITHUB_API_URL: api.url })).code, 0);
  const first = await readFile(join(dir, 'releases.json'), 'utf8');

  const r = await runSync(dir, { GITHUB_API_URL: api.url });

  assert.equal(r.code, 0, r.all);
  assert.equal(await readFile(join(dir, 'releases.json'), 'utf8'), first);
});

test('releases sync drops a recorded release once the source says there is none', async (t) => {
  const api = await fakeGitHub(t);
  const before = JSON.stringify({
    checkedAt: '2026-01-01T00:00:00.000Z',
    repos: {
      'fresh-tool': {
        tag: 'v0.1.0',
        name: null,
        publishedAt: '2026-01-01T00:00:00.000Z',
        zipUrl: 'https://github.com/Ethanyang9512/fresh-tool/archive/refs/tags/v0.1.0.zip',
        zipName: 'fresh-tool-0.1.0.zip',
      },
    },
  });
  const dir = await makeDataDir([{ slug: 'fresh', repo: 'fresh-tool', status: 'open-source' }], before);

  const r = await runSync(dir, { GITHUB_API_URL: api.url });

  assert.equal(r.code, 0, r.all);
  assert.equal(r.all, 'fresh-tool 无版本\n');
  const saved = JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8'));
  assert.deepEqual(saved.repos, {});
  // 内容变了，checkedAt 跟着更新
  assert.notEqual(saved.checkedAt, '2026-01-01T00:00:00.000Z');
});
