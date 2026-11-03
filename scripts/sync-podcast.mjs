// 单集同步：读小宇宙节目页，把单集按 eid 合并进 data/podcast.json（只增不删，小宇宙上删掉的除外），
// data/seed-episodes.json 里的种子单集每次都一起并入（节目页只嵌最新 15 期，最早两期靠种子）。
// 小宇宙上删掉的单集：这次页面给的总期数（episodeCount）比上次记下的少，页面这一批的时间范围里
// （不早于最旧的那期）缺掉的已知单集才判为被删：从 podcast.json 去掉，eid 记进 data/held.json 的 deleted。
// deleted 只由这个脚本增减（episodes 是看门因隐私撤下的，脚本从不改它，别的键也原样留着）：以后哪次页面上
// 又出现了 deleted 里的某期（比如那次拿到的是一整页旧缓存，最新一期被误判），就从 deleted 里拿掉，照常并回 podcast.json。
// 总期数没变少就不判（页面可能一时不完整），只靠期数核对。
// held.json 的格式和构建查同一套（lib/held.mjs 的 heldLists；那个文件不引外部依赖，没装 node_modules 也能跑这个脚本）：
// 文件不存在才当空清单，格式不对报 E_HELD <键> 应为<类型>、退出 1、什么都不写。
// 成功只打印新增、下架、恢复的 eid 和期数，不打印标题。失败只打印错误码、退出 1、不写文件：
// 异常原文可能带出页面片段，会进公开的 Actions 日志。
// 页面上的节目编号和 podcast.json 里记的不一样（比如被跳转到别的节目）就报 E_OTHER_PODCAST，不合并也不下架。
// 用法：node scripts/sync-podcast.mjs [--source-file <本地页面>] [--data-dir <目录>]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { heldErrorCode, heldLists } from '../lib/held.mjs';
import { mergeEpisodes, removedEpisodes } from '../lib/merge.mjs';
import { parsePodcastPage } from '../lib/podcast-source.mjs';

const PAGE_URL = 'https://www.xiaoyuzhoufm.com/podcast/6a103e614c31a34a749047da';
// 小宇宙对 Node 默认的 User-Agent（"node"）返回 403；如实写明是本站的同步程序
const USER_AGENT = 'site-sync/1.0 (+https://ethanyang9512.github.io)';
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const EMPTY_HELD = { episodes: [], releases: [], posts: [] };

const fetchError = (status) => Object.assign(new Error('FETCH'), { status });

async function fetchPage() {
  let res;
  try {
    res = await fetch(PAGE_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw fetchError();
  }
  if (!res.ok) throw fetchError(res.status);
  try {
    return await res.text();
  } catch {
    throw fetchError();
  }
}

// 文件不存在返回 undefined；文件里写的是 JSON null 照样返回 null，不能和“不存在”混在一起
async function readJsonIfExists(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}

async function main() {
  const { values } = parseArgs({ options: { 'source-file': { type: 'string' }, 'data-dir': { type: 'string' } } });
  const dataDir = values['data-dir'] ?? DEFAULT_DATA_DIR;
  const file = join(dataDir, 'podcast.json');
  const heldFile = join(dataDir, 'held.json');
  const old = await readJsonIfExists(file);
  // held.json：只有文件不存在才用默认的空清单；在的话和构建同一套规则检查（lib/held.mjs 的 heldLists：
  // 缺的键当空，在的话必须是字符串数组），格式不对（包括内容是 null）就报 E_HELD，不能当成空的再重写覆盖掉。
  // 先查好再写文件：失败时两个文件都不动
  const heldRead = await readJsonIfExists(heldFile);
  const held = heldRead === undefined ? EMPTY_HELD : heldRead;
  const lists = heldLists(held);
  const deletedBefore = lists.deleted;
  const seeds = JSON.parse(await readFile(join(dataDir, 'seed-episodes.json'), 'utf8'));
  const html = values['source-file'] ? await readFile(values['source-file'], 'utf8') : await fetchPage();
  const source = parsePodcastPage(html);
  if (old?.podcast?.pid && old.podcast.pid !== source.podcast.pid) throw new Error('OTHER_PODCAST');

  // deleted 里的单集页面上又有了：恢复，从 deleted 拿掉，下面照常并回来。页面上还没有的就不并进来：
  // 种子文件里的也不；上次只写成了 held.json、还留在 podcast.json 里的，这次一并去掉
  const onPage = new Set(source.episodes.map((e) => e.eid));
  const restored = deletedBefore.filter((eid) => onPage.has(eid));
  const stillDeleted = deletedBefore.filter((eid) => !onPage.has(eid));
  const notDeleted = (e) => !stillDeleted.includes(e.eid);
  // 页面上的排在种子后面：同一个 eid 以页面为准
  const { episodes: merged, added } = mergeEpisodes(
    (old?.episodes ?? []).filter(notDeleted),
    [...seeds, ...source.episodes].filter(notDeleted),
  );
  const { pid, title, episodeCount } = source.podcast;
  // 下架只在总期数比上次记下的少时才判（见文件头）
  const lastCount = old?.podcast?.episodeCount;
  const removed = Number.isInteger(lastCount) && episodeCount < lastCount ? removedEpisodes(merged, source.episodes) : [];
  const episodes = merged.filter((e) => !removed.includes(e.eid));
  const deleted = [...stillDeleted, ...removed];
  const next = {
    podcast: {
      pid,
      title,
      url: `https://www.xiaoyuzhoufm.com/podcast/${pid}`,
      episodeCount,
      checkedAt: old?.podcast?.checkedAt ?? null,
    },
    episodes,
  };
  // 先写 held.json：万一 podcast.json 没写成，那期也已经不显示，下次同步再从 podcast.json 去掉。
  // 只改 deleted，held.json 里别的键原样写回
  if (JSON.stringify(deleted) !== JSON.stringify(deletedBefore)) {
    await writeFile(heldFile, `${JSON.stringify({ ...held, deleted }, null, 2)}\n`);
  }
  // 内容没变就不动文件（checkedAt 也不改），免得每天产生只改时间戳的提交
  if (JSON.stringify(next) !== JSON.stringify(old)) {
    next.podcast.checkedAt = new Date().toISOString();
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  const heldEpisodes = new Set(lists.episodes);
  const shown = episodes.filter((e) => !heldEpisodes.has(e.eid)).length;
  console.log(`新增 ${added.length} 期：${added.join(' ')}`);
  if (removed.length > 0) console.log(`下架 ${removed.length} 期：${removed.join(' ')}`);
  if (restored.length > 0) console.log(`恢复 ${restored.length} 期：${restored.join(' ')}`);
  console.log(`站上 ${shown} 期 / 来源 ${episodeCount} 期`);
}

function errorCode(err) {
  if (err?.message === 'HELD') return heldErrorCode(err);
  if (err?.message === 'FETCH') return err.status ? `E_FETCH ${err.status}` : 'E_FETCH';
  if (['NO_NEXT_DATA', 'PARSE', 'NO_EPISODES', 'OTHER_PODCAST'].includes(err?.message)) return `E_${err.message}`;
  return 'E_INTERNAL';
}

main().catch((err) => {
  console.error(errorCode(err));
  process.exitCode = 1;
});
