// 给搜索引擎和 AI 读的部分：JSON-LD、llms.txt、sitemap.xml、robots.txt、博客 RSS。链接一律用绝对地址。
import { esc, formatDate, formatDuration, isoBeijing, isoDuration } from './format.mjs';
import { GITHUB_OWNER } from './site-config.mjs';

export const workPath = (work) => `/works/${work.slug}/`;
export const postPath = (post) => `/blog/${post.slug}/`;

// 除 404 外的全部页面（根路径）
export function pagePaths(site) {
  return [
    '/',
    '/works/',
    ...site.works.map(workPath),
    '/podcast/',
    '/about/',
    ...(site.posts.length > 0 ? ['/blog/', ...site.posts.map(postPath)] : []),
  ];
}

export const absUrl = (site, path) => `${site.profile.siteUrl.replace(/\/+$/, '')}${path}`;

// 来源期数多于站上期数时差几期（小宇宙节目页只给最新 15 期，被撤下的也不在站上）
export const missingEpisodes = (podcast) => Math.max(0, podcast.episodeCount - podcast.episodes.length);

// < 写成 <：单集标题里就算有 </script> 也不会提前结束这段脚本
export function ldScript(data) {
  const json = JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

const author = (site) => ({ '@type': 'Person', name: site.profile.name, url: absUrl(site, '/') });
const workType = (work) => (work.status === 'private' ? 'CreativeWork' : 'SoftwareSourceCode');
// 许可证地址：知识共享的许可证用它官网的地址，其余（MIT 这类）按 SPDX 编号拼
const LICENSE_URLS = { 'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/' };
const licenseUrl = (name) => LICENSE_URLS[name] ?? `https://spdx.org/licenses/${name}.html`;

// 代码和文档分开授权的（有 docsLicense）给两个地址组成的数组
function licenseLd(work) {
  if (work.status === 'private' || !work.license) return undefined;
  return work.docsLicense ? [licenseUrl(work.license), licenseUrl(work.docsLicense)] : licenseUrl(work.license);
}

export function personLd(site) {
  return {
    '@type': 'Person',
    name: site.profile.name,
    url: absUrl(site, '/'),
    description: site.profile.tagline,
    sameAs: [`https://github.com/${GITHUB_OWNER}`],
  };
}

export function worksLd(site) {
  return {
    '@type': 'CollectionPage',
    name: '作品',
    url: absUrl(site, '/works/'),
    hasPart: site.works.map((w) => ({ '@type': workType(w), name: w.name, url: absUrl(site, workPath(w)) })),
  };
}

export function workLd(site, work) {
  const open = work.status !== 'private';
  return {
    '@type': workType(work),
    name: work.name,
    alternateName: work.nameZh,
    description: work.summary,
    url: absUrl(site, workPath(work)),
    inLanguage: 'zh-CN',
    author: author(site),
    codeRepository: open && work.repo ? `https://github.com/${GITHUB_OWNER}/${work.repo}` : undefined,
    license: licenseLd(work),
  };
}

export function podcastLd(site) {
  const { podcast, profile } = site;
  return {
    '@type': 'PodcastSeries',
    name: podcast.title,
    description: profile.podcastIntro,
    url: absUrl(site, '/podcast/'),
    sameAs: podcast.url,
    inLanguage: 'zh-CN',
    author: { ...author(site), alternateName: profile.podcastAuthor },
    episode: podcast.episodes.map((e) => ({
      '@type': 'PodcastEpisode',
      name: e.title,
      url: e.url,
      datePublished: isoBeijing(e.pubDate),
      duration: isoDuration(e.duration),
    })),
  };
}

export function blogLd(site) {
  return {
    '@type': 'Blog',
    name: `${site.profile.name} 的博客`,
    url: absUrl(site, '/blog/'),
    author: author(site),
    blogPost: site.posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: absUrl(site, postPath(p)),
      datePublished: isoBeijing(p.date),
    })),
  };
}

export function postLd(site, post) {
  return {
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.summary || undefined,
    datePublished: isoBeijing(post.date),
    url: absUrl(site, postPath(post)),
    inLanguage: 'zh-CN',
    author: author(site),
  };
}

// Markdown 链接文字里的 \ [ ] 要转义，不然标题里一个 ] 就会弄断链接
const linkText = (text) => String(text).replace(/[\\[\]]/g, '\\$&');

// llmstxt.org：一级标题、一行引用摘要、几节链接列表
export function llmsTxt(site) {
  const { profile, works, podcast, posts } = site;
  const missing = missingEpisodes(podcast);
  const item = (text, url, note) => `- [${linkText(text)}](${url}): ${note}`;
  const lines = [`# ${profile.name}`, '', `> ${profile.tagline}`, '', profile.intro, '', '## 作品', ''];
  for (const w of works) {
    const status = w.status === 'private' ? '暂未开源。' : '';
    lines.push(item(`${w.name}（${w.nameZh}）`, absUrl(site, workPath(w)), `${w.summary}${status}`));
  }
  lines.push(
    '',
    '## 播客',
    '',
    item(
      `《${podcast.title}》`,
      absUrl(site, '/podcast/'),
      `${profile.podcastIntro}共 ${podcast.episodeCount} 期` +
        `${missing ? `，另有 ${missing} 期未在本站列出，可在小宇宙收听全部` : ''}。每期都链到小宇宙的公开单集页，网页上不用登录就能播放。`,
    ),
    item('小宇宙节目页', podcast.url, '在小宇宙收听全部节目'),
  );
  for (const e of podcast.episodes) lines.push(item(e.title, e.url, `${formatDate(e.pubDate)}，${formatDuration(e.duration)}`));
  lines.push('', '## 关于', '', item(`关于 ${profile.name}`, absUrl(site, '/about/'), profile.about[0]));
  if (posts.length > 0) {
    lines.push('', '## 博客', '');
    for (const p of posts) {
      lines.push(item(p.title, absUrl(site, postPath(p)), `${formatDate(p.date)}${p.summary ? `，${p.summary}` : ''}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function sitemapXml(site) {
  const urls = pagePaths(site).map((p) => `<url><loc>${esc(absUrl(site, p))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

export function robotsTxt(site) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absUrl(site, '/sitemap.xml')}\n`;
}

// 博客 RSS 2.0：每篇给标题、链接、日期和摘要，全文在网站上看
export function feedXml(site) {
  const { profile, posts } = site;
  const items = posts.map((p) => {
    const url = esc(absUrl(site, postPath(p)));
    return `<item>
<title>${esc(p.title)}</title>
<link>${url}</link>
<guid isPermaLink="true">${url}</guid>
<pubDate>${new Date(p.date).toUTCString()}</pubDate>
${p.summary ? `<description>${esc(p.summary)}</description>\n` : ''}</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${esc(profile.name)} 的博客</title>
<link>${esc(absUrl(site, '/blog/'))}</link>
<description>${esc(profile.tagline)}</description>
<language>zh-CN</language>
<atom:link href="${esc(absUrl(site, '/blog/feed.xml'))}" rel="self" type="application/rss+xml"/>
${items.join('\n')}
</channel>
</rss>
`;
}
