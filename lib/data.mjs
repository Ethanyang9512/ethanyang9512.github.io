// 读站点数据，滤掉 held.json 里被撤下的项（单集按 eid、版本按 "<repo>:<tag>"、博客按 slug）。
// 版本编号用冒号连接，免得看着像邮箱地址。单集还有一份 deleted：小宇宙上删掉的，同步写进去，同样跳过。
// held.json 的格式不对就抛 HELD（规则在 lib/held.mjs，同步也用它），构建失败：不能悄悄当成“没撤下”，让本该藏起来的项照样上站。
// loadSite(rootDir) → {
//   profile,   data/profile.json 原样
//   works,     data/works.json 原样
//   podcast:   { pid, title, url, episodeCount, checkedAt, episodes }，单集保持 podcast.json 的顺序（同步写成新的在前）
//   releases:  { [repo]: { tag, name, publishedAt, zipUrl, zipName } }
//   held,      data/held.json 原样
//   posts:     [{ slug, title, date, summary, html }]，新的在前
// }
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePost } from './blog.mjs';
import { heldLists } from './held.mjs';

async function readPosts(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const posts = [];
  const slugs = new Set();
  // 文件名排好序，重复时报的总是后一篇；同一个 slug 会写到同一个目录，不能让后一篇悄悄盖掉前一篇
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const post = parsePost(await readFile(join(dir, name), 'utf8'), name);
    if (slugs.has(post.slug)) throw Object.assign(new Error('BAD_POST'), { file: name });
    slugs.add(post.slug);
    posts.push(post);
  }
  return posts.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || (a.slug < b.slug ? -1 : 1));
}

export async function loadSite(rootDir) {
  const json = async (name) => JSON.parse(await readFile(join(rootDir, 'data', name), 'utf8'));
  const [profile, works, podcastFile, releasesFile, held] = await Promise.all(
    ['profile.json', 'works.json', 'podcast.json', 'releases.json', 'held.json'].map(json),
  );
  const lists = heldLists(held);
  const heldEpisodes = new Set([...lists.episodes, ...lists.deleted]);
  const heldReleases = new Set(lists.releases);
  const heldPosts = new Set(lists.posts);

  return {
    profile,
    works,
    podcast: { ...podcastFile.podcast, episodes: podcastFile.episodes.filter((e) => !heldEpisodes.has(e.eid)) },
    releases: Object.fromEntries(
      Object.entries(releasesFile.repos).filter(([repo, r]) => !heldReleases.has(`${repo}:${r.tag}`)),
    ),
    held,
    posts: (await readPosts(join(rootDir, 'content', 'blog'))).filter((p) => !heldPosts.has(p.slug)),
  };
}
