// 版本同步：按 data/works.json 里的 repo（仓库名，所属账号见 lib/site-config.mjs）读 GitHub 最新版本，写 data/releases.json。
// 仓库还没有任何 Release（最新版本接口回 404，而仓库本身查得到）就不记这个仓库：页面上没有版本号和下载按钮，
// 打印“仓库名 无版本”，不算失败。仓库本身也是 404（删了、转成私有，或者名字写错了）报 E_REPO_GONE <仓库名>：
// 要人去改 works.json，所以让这次运行标红，不悄悄吞掉。
// 只打印仓库名和版本号；失败只打印错误码、退出 1、不写文件。
// 有 GITHUB_TOKEN 就带上（Actions 里有）；GITHUB_API_URL 是 Actions 自带的环境变量，没有就用公共地址。
// 用法：node scripts/sync-releases.mjs [--data-dir <目录>]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GITHUB_OWNER as OWNER } from '../lib/site-config.mjs';

const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

const fetchError = (status) => Object.assign(new Error('FETCH'), { status });

async function apiGet(path) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    return await fetch(`${api}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw fetchError();
  }
}

// 返回最新版本；仓库还没有任何 Release 返回 null。
// 最新版本接口在“还没有 Release”和“仓库不存在（或看不到）”时都回 404，所以 404 时再查仓库本身。
async function latestRelease(repo) {
  const res = await apiGet(`/repos/${OWNER}/${repo}/releases/latest`);
  if (res.status === 404) {
    const repoRes = await apiGet(`/repos/${OWNER}/${repo}`);
    if (repoRes.status === 404) throw Object.assign(new Error('REPO_GONE'), { repo });
    if (!repoRes.ok) throw fetchError(repoRes.status);
    return null;
  }
  if (!res.ok) throw fetchError(res.status);
  let release;
  try {
    release = await res.json();
  } catch {
    throw new Error('PARSE');
  }
  const tag = release?.tag_name;
  const time = Date.parse(release?.published_at);
  // tag 会拼进下载地址和文件名，只收常见写法
  if (typeof tag !== 'string' || !/^[\w.-]+$/.test(tag) || Number.isNaN(time)) throw new Error('PARSE');
  return {
    tag,
    name: typeof release.name === 'string' ? release.name : null,
    publishedAt: new Date(time).toISOString(),
    zipUrl: `https://github.com/${OWNER}/${repo}/archive/refs/tags/${tag}.zip`,
    zipName: `${repo}-${tag.replace(/^v/, '')}.zip`,
  };
}

async function readJsonOrNull(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(text);
}

async function main() {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
  const dataDir = values['data-dir'] ?? DEFAULT_DATA_DIR;
  const works = JSON.parse(await readFile(join(dataDir, 'works.json'), 'utf8'));
  const file = join(dataDir, 'releases.json');
  const old = await readJsonOrNull(file);

  const repos = {};
  const lines = [];
  for (const { repo } of works) {
    if (!repo) continue;
    const release = await latestRelease(repo);
    if (release) repos[repo] = release;
    lines.push(`${repo} ${release ? release.tag : '无版本'}`);
  }
  const next = { checkedAt: old?.checkedAt ?? null, repos };
  // 内容没变就不动文件（checkedAt 也不改），免得每天产生只改时间戳的提交
  if (JSON.stringify(next) !== JSON.stringify(old)) {
    next.checkedAt = new Date().toISOString();
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  for (const line of lines) console.log(line);
}

function errorCode(err) {
  if (err?.message === 'REPO_GONE') return `E_REPO_GONE ${err.repo}`;
  if (err?.message === 'FETCH') return err.status ? `E_FETCH ${err.status}` : 'E_FETCH';
  if (err?.message === 'PARSE') return 'E_PARSE';
  return 'E_INTERNAL';
}

main().catch((err) => {
  console.error(errorCode(err));
  process.exitCode = 1;
});
