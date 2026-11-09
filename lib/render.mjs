// 各页的 HTML 模板。只出静态 HTML：不加载外站资源、不跑 JS，关掉 JS 也能读到全部正文。
// 版式是单栏，样式全在 assets/site.css。每页从上到下读，没有侧栏；整页只有一个高亮色，以名字后面的红色方块出现。
// 结构约定（测试靠这些找内容，换皮时请保留）：正文在 <main>，导航在 <nav>；首页 section#intro、#posts（有博客才有）、
// #works、#latest-episode、#contact；/podcast/ 页 section#listen、#episodes；作品页 section#highlights，开源的作品页
// 另有 section#get（怎么装，暂未开源的作品页没有这一块）；/about/ 页 section#find-me。
// 站内链接一律相对（href()），预览时目录链接补 index.html；404 例外，用根路径（Pages 在任意深度的地址上返回它），
// 所以 404 页上不放页内锚点（跳到正文）。图标是内联 SVG，不用 <use href>，同样为了 404 页。
// works.json 的 visual.src 写站内根路径（如 /assets/img/x.svg），为 null 时不出图；width、height 有就写上。
import { esc, formatDate, formatDuration, href } from './format.mjs';
import { GITHUB_OWNER } from './site-config.mjs';
import {
  absUrl,
  blogLd,
  ldScript,
  missingEpisodes,
  personLd,
  podcastLd,
  postLd,
  postPath,
  workLd,
  workPath,
  worksLd,
} from './seo.mjs';

const NOT_FOUND = '/404.html';
const COVER = { src: '/assets/img/podcast-cover.jpg', width: 480, height: 480 };
const QR = { src: '/assets/img/podcast-qr.svg', size: 140 }; // 码是 35 格：140 = 每格 4 像素，边缘不发虚
const SHARE = { src: '/assets/img/share.png', width: 1200, height: 630 }; // 分享卡的图（链接发进飞书、Telegram、X 时显示）
const HOME_POSTS = 5; // 首页“文章”最多列几篇

const fileOf = (path) => (path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1));

// ---------- 小部件 ----------

// 图标：站内 →、站外 ↗、下载 ↓（带底线）、返回 ←；线宽固定，跟着字号缩放
const ICON_PATHS = {
  arrow: 'M1.5 8h12.5M9 3.5 13.5 8 9 12.5',
  external: 'M3.5 12.5 12.5 3.5M5.5 3.5h7v7',
  download: 'M8 1.5v10M3.5 7.5 8 12l4.5-4.5M2.5 14.5h11',
  back: 'M14.5 8H2M7 3.5 2.5 8 7 12.5',
};
const icon = (name) =>
  `<svg class="icon icon--${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}" vector-effect="non-scaling-stroke"/></svg>`;

// 红色方块：全站唯一的高亮色，只跟在名字后面
const SQUARE = '<span class="square" aria-hidden="true"></span>';

// 并排的两段之间的分隔符：两边留空格，只读文字的读者也不会读到连在一起的字。后面那个是不换行的空格，
// 折行时分隔号跟着下一项走，不会单独挂在行尾
const SEP = ' <span class="sep" aria-hidden="true">·</span>\u00a0';

// 纯拉丁字母的名字标上 lang="en"：读屏按英文念，字体按拉丁字走
const latin = (text) => (/^[\x20-\x7e]+$/.test(text) ? ' lang="en"' : '');

// 数字类（日期、版本号、时长里的数字）用等宽字体，汉字和英文标签用正文字体
const num = (text) => `<span class="num">${esc(text)}</span>`;
const nums = (text) => esc(text).replace(/\d+/g, (d) => `<span class="num">${d}</span>`);
const time = (iso) => `<time class="num" datetime="${formatDate(iso)}">${formatDate(iso)}</time>`;
const duration = (sec) => nums(formatDuration(sec));

// 不拆开的词：正文按字断行时，词表里的词整个挪到下一行，不断成“一 / 个”“小红 / 书”。
// keep(文字) 先转义，再给词表里的词包上不换行的 span，不加不减任何字，只读文字的读者看到的还是原句。
// 只用在作者自己写的正文上；单集标题、安装命令这类照原样放的整句不包，免得拆开原文
const KEEP_WORDS = [
  '一个', '个人', '可以', '链接', '智能体', '小红书', '公众号', '小宇宙', '录音', '格式', '示意图', '版本号', 'GitHub 上', 'Claude Code',
  '检查', '第三方', '剪辑', '程序', '验收员', '飞书', '汇报片', '一路', 'WorkBuddy',
];
const KEEP = new RegExp(KEEP_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
export const keep = (text) => esc(text).replace(KEEP, (w) => `<span class="nobr">${w}</span>`);

const img = (to, { src, width, height }, alt, { lazy = false, cls = '' } = {}) =>
  `<img${cls ? ` class="${cls}"` : ''} src="${to(src)}"${width ? ` width="${width}" height="${height}"` : ''} alt="${esc(alt)}"${lazy ? ' loading="lazy"' : ''} decoding="async">`;

// 一个区块：小标题加内容，从上到下排
function block({ id, title, body, cls = '' }) {
  return `<section id="${id}" class="block${cls ? ` ${cls}` : ''}" aria-labelledby="${id}-title">
<h2 class="block__title" id="${id}-title">${title}</h2>
${body}
</section>`;
}

// 栏目页和详情页的页头：大标题，下面可以跟一行副标题
function pageHead({ title, titleAttrs = '', sub = '' }) {
  return `<header class="page-head">
<h1 class="page-head__title" id="page-title"${titleAttrs}>${title}</h1>
${sub ? `<p class="page-head__sub">${sub}</p>\n` : ''}</header>`;
}

// 二维码：扫出来是节目主页。四周 16px 白边（大于边长的 10%）；手机上扫不了自己的屏幕，样式里只在平板和电脑上显示
function qrBlock(site, to) {
  const { title } = site.podcast;
  return `<div class="qr">
<span class="qr__box"><img src="${to(QR.src)}" width="${QR.size}" height="${QR.size}" alt="扫码打开小宇宙上的《${esc(title)}》节目页" loading="lazy" decoding="async"></span>
<p class="qr__caption" aria-hidden="true">手机扫码收听</p>
</div>`;
}

// 许可证照 works.json 里的名字写：代码和文档分开授权（有 docsLicense）的写“代码 MIT、文档 CC BY 4.0”
const nobr = (text) => `<span class="nobr">${esc(text)}</span>`;
const licenses = (work) =>
  work.docsLicense ? `${nobr(`代码 ${work.license}`)}、${nobr(`文档 ${work.docsLicense}`)}` : `${esc(work.license)} 许可证`;

// 状态的短标签：列表里只写开没开源，许可证写在作品页页底
const statusTag = (work) => (work.status === 'private' ? '未开源' : '已开源');

// 列表的一行：一行小号元信息（日期，或日期加时长），一行标题。只有标题是链接文字，样式把点按范围铺满整行
function row({ date, note = '', title, link, external = false, ep = false, summary = '' }) {
  return `<li class="row">
<p class="row__meta">${time(date)}${note ? `${SEP}${note}` : ''}</p>
<p class="row__title"><a class="row__link${ep ? ' ep-link' : ''}" href="${link}"><span class="row__label">${esc(title)}</span>${icon(external ? 'external' : 'arrow')}</a></p>
${summary ? `<p class="row__summary">${esc(summary)}</p>\n` : ''}</li>`;
}

// 作品列表的一条：英文名（链接）、中文名、开没开源；作品列表页再加那句介绍（首页不加，两处各有分工）
function workEntry(to, work, heading, { summary = false } = {}) {
  return `<li class="entry">
<${heading} class="entry__name"><a href="${to(workPath(work))}"${latin(work.name)}>${esc(work.name)}</a></${heading}>
<p class="entry__note">${esc(work.nameZh)}${SEP}${statusTag(work)}</p>
${summary ? `<p class="entry__summary">${keep(work.summary)}</p>
` : ''}</li>`;
}

function navItems(site) {
  return [
    ['作品', '/works/'],
    ['播客', '/podcast/'],
    ...(site.posts.length > 0 ? [['博客', '/blog/']] : []),
    ['关于', '/about/'],
  ];
}

// ---------- 页面骨架 ----------

// page(to) → {title, description, ld, feed, body}；to(根路径) 给出这一页该写的链接
function layout(site, ctx, path, kind, page) {
  const notFound = path === NOT_FOUND;
  const to = (target) => esc(notFound ? target : href(path, target, { preview: ctx.preview }));
  const { title, description, ld, feed, body } = page(to);
  const { profile } = site;
  // 栏目页本身标 page；栏目下的详情页标 true（所在栏目，不是当前页）
  const current = (target) => {
    if (path === target) return ' aria-current="page"';
    return path.startsWith(target) ? ' aria-current="true"' : '';
  };
  const nav = navItems(site).map(([label, target]) => `<li><a href="${to(target)}"${current(target)}>${label}</a></li>`);
  // 分享卡：链接发进飞书、Telegram、X 等软件时显示的标题、简介和图。除 404 外每页都有；标题、简介、网址和页面自己的一致，
  // 图和网址写绝对地址（别的网站读不懂相对地址）；博客文章标 article，其余 website
  const share = notFound
    ? []
    : [
        `<meta property="og:type" content="${kind === 'post' ? 'article' : 'website'}">`,
        `<meta property="og:site_name" content="${esc(profile.name)}">`,
        `<meta property="og:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(description)}">`,
        `<meta property="og:url" content="${esc(absUrl(site, path))}">`,
        `<meta property="og:image" content="${esc(absUrl(site, SHARE.src))}">`,
        `<meta property="og:image:width" content="${SHARE.width}">`,
        `<meta property="og:image:height" content="${SHARE.height}">`,
        `<meta property="og:image:alt" content="${esc(`${profile.name} 的个人网站：作品、播客`)}">`,
        '<meta property="og:locale" content="zh_CN">',
        '<meta name="twitter:card" content="summary_large_image">',
      ];
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    notFound ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(absUrl(site, path))}">`,
    ...share,
    `<meta name="generator" content="site-build ${esc(ctx.version)}">`,
    '<meta name="theme-color" content="#fbfbf9">',
    `<link rel="icon" href="${to('/assets/favicon.svg')}" type="image/svg+xml">`,
    `<link rel="stylesheet" href="${to('/assets/site.css')}">`,
    ...(feed ? [`<link rel="alternate" type="application/rss+xml" title="${esc(profile.name)} 的博客" href="${to('/blog/feed.xml')}">`] : []),
    ...(ld ? [ldScript(ld)] : []),
  ];
  // 首页的名字就是页面的一级标题，页头不再重复放一个
  const mark = kind === 'home' ? '' : `<a class="site-mark" href="${to('/')}"><span${latin(profile.name)}>${esc(profile.name)}</span>${SQUARE}</a>\n`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
${head.join('\n')}
</head>
<body class="page-${kind}">
${notFound ? '' : '<a class="skip-link" href="#main">跳到正文</a>\n'}<header class="site-header">
<div class="wrap site-header__inner">
${mark}<nav class="site-nav" aria-label="栏目">
<ul>
${nav.join('\n')}
</ul>
</nav>
</div>
</header>
<main id="main">
<div class="wrap">
${body}
</div>
</main>
<footer class="site-footer">
<div class="wrap">
<p class="footer__license">© ${esc(profile.name)}${SEP}文字和自绘示意图 ${esc(profile.license)}<span class="nobr">（播客封面除外）</span>${SEP}本站代码 MIT</p>
</div>
</footer>
</body>
</html>
`;
}

// ---------- 首页 ----------

function homePage(site, to) {
  const { profile, podcast, posts } = site;
  const latest = podcast.episodes[0];
  const intro = `<section id="intro" class="intro" aria-labelledby="intro-title">
<h1 class="intro__name" id="intro-title"><span${latin(profile.name)}>${esc(profile.name)}</span>${SQUARE}</h1>
<p class="intro__tagline">${keep(profile.tagline)}</p>
</section>`;

  // 文章：有博客才出现，最新的几篇在上
  const latestPosts =
    posts.length > 0
      ? block({
          id: 'posts',
          title: '文章',
          body: `<ol class="rows">
${posts.slice(0, HOME_POSTS).map((p) => row({ date: p.date, title: p.title, link: to(postPath(p)) })).join('\n')}
</ol>
<p class="more"><a class="text-link" href="${to('/blog/')}">全部文章${icon('arrow')}</a></p>`,
        })
      : '';

  const works = block({
    id: 'works',
    title: '作品',
    body: `<ul class="entries">
${site.works.map((w) => workEntry(to, w, 'h3')).join('\n')}
</ul>`,
  });

  // 播客：最新一期的标题就是“听”的链接
  // 小宇宙节目页的链接在下面的联系方式里已经有了，这里不再放一个
  const podcastBlock = latest
    ? block({
        id: 'latest-episode',
        title: `播客《${esc(podcast.title)}》`,
        body: `<p class="podcast-intro">${keep(profile.podcastIntro)}</p>
<p class="latest">最新一期：<a class="ep-link" href="${esc(latest.url)}"><span class="ep-link__text">${esc(latest.title)}</span>${icon('external')}</a></p>
<p class="meta">${time(latest.pubDate)}${SEP}${duration(latest.duration)}</p>
<p class="more"><a class="text-link" href="${to('/podcast/')}">全部单集${icon('arrow')}</a></p>`,
      })
    : '';

  const contact = block({ id: 'contact', title: '在哪找到我', body: contactLine(profile) });

  return {
    title: profile.name,
    description: profile.tagline,
    ld: personLd(site),
    body: [intro, latestPosts, works, podcastBlock, contact].filter(Boolean).join('\n'),
  };
}

// 首页的联系方式：一行，平台名加账号名（只读文字的读者也看得到账号名）。GitHub、小宇宙可点；公众号没有链接
function contactLine(profile) {
  const items = profile.links.map((l) => {
    const text = l.url ? `<a class="text-link" href="${esc(l.url)}"${latin(l.text)}>${esc(l.text)}${icon('external')}</a>` : esc(l.text);
    return `<span class="contact-line__item">${esc(l.label)}：${text}</span>`;
  });
  return `<p class="contact-line">${items.join(SEP)}</p>`;
}

// 关于页的联系方式：一行一项；公众号没有链接，写明在微信里怎么找
function contacts(profile) {
  const rows = profile.links.map((l) => {
    let dd = esc(l.text);
    if (l.url) dd = `<a class="text-link" href="${esc(l.url)}">${esc(l.text)}${icon('external')}</a>`;
    else if (l.label === '公众号') dd = keep(`微信里搜索公众号「${l.text}」`);
    return `<div><dt>${esc(l.label)}</dt> <dd>${dd}</dd></div>`;
  });
  return `<dl class="contacts">\n${rows.join('\n')}\n</dl>`;
}

// ---------- 作品 ----------

function worksPage(site, to) {
  const { profile, works } = site;
  return {
    title: `作品 · ${profile.name}`,
    description: `${profile.name} 做的 ${works.length} 件作品：${works.map((w) => w.name).join('、')}。`,
    ld: worksLd(site),
    body: `${pageHead({ title: '作品' })}
<ul class="entries entries--works">
${works.map((w) => workEntry(to, w, 'h2', { summary: true })).join('\n')}
</ul>`,
  };
}

// 亮点：开头是一个短的小标题加冒号（“数字可复核：……”）时把小标题加重；
// 只有整张列表每一条都这样写才加重，不然一律不加，免得同一张表里有的加粗有的没有
const LEAD_IN = /^([^：]{2,12})：([\s\S]+)$/;
function points(highlights) {
  const leads = highlights.map((h) => LEAD_IN.exec(h));
  const bold = leads.every(Boolean);
  const items = highlights.map((text, i) =>
    bold ? `<li class="point"><span class="point__lead">${keep(leads[i][1])}：</span>${keep(leads[i][2])}</li>` : `<li class="point">${keep(text)}</li>`,
  );
  return `<ul class="points">\n${items.join('\n')}\n</ul>`;
}

// 下载链接的地址：没取源码包（ctx.downloads 是 null，比如预览）时直接指向 GitHub 的源码包；
// 取了的指向本站 downloads/；构建时没取到的返回 null，不放链接，也不链到取不到的地址
function downloadLink(to, release, ctx) {
  if (!ctx.downloads) return esc(release.zipUrl);
  return ctx.downloads.has(release.zipName) ? to(`/downloads/${release.zipName}`) : null;
}

// 怎么装（只有开源的作品才有这一块）：最省事的在前。①装进 Claude Code；②在 WorkBuddy 里搜名字；
// ③GitHub 源码、源码包。有哪个才显示哪个
function waysToGet(site, to, work, ctx) {
  const parts = [];
  const commands = work.install?.claudeCode ?? [];
  if (commands.length > 0) {
    parts.push(`<p>${keep('先装好 Anthropic 的 AI 编程助手 Claude Code，再在里面依次输入：')}</p>
<pre class="code" tabindex="0"><code>${commands.map(esc).join('\n')}</code></pre>`);
  }
  const items = work.workbuddy?.items ?? [];
  if (items.length > 0) {
    const lead = commands.length > 0 ? '也可以在腾讯 WorkBuddy 里搜名字安装：' : '在腾讯 WorkBuddy 里搜名字安装：';
    parts.push(`<p>${keep(lead)}</p>
<ul class="workbuddy-items">
${items.map((i) => `<li>${esc(i.name)}<span class="workbuddy-items__type">（${esc(i.type)}${i.type === '专家团' ? '，在专家市场' : ''}）</span></li>`).join('\n')}
</ul>`);
  }
  const links = [];
  if (work.repo) {
    links.push(`<a class="text-link" href="https://github.com/${GITHUB_OWNER}/${esc(work.repo)}">GitHub 源码${icon('external')}</a>`);
  }
  const release = work.repo ? site.releases[work.repo] : undefined;
  const link = release ? downloadLink(to, release, ctx) : null;
  if (link) {
    links.push(`<a class="text-link" href="${link}">下载源码包 <span class="num">${esc(release.zipName)}</span>${icon('download')}</a>`);
  }
  if (links.length > 0) parts.push(`<p class="get-links">${links.join(SEP)}</p>`);
  return parts.join('\n');
}

// 作品页页底一行：版本 · 发布日期 · 许可（只有开源的作品有；未开源写在页头的副标题里）
function workMeta(site, work) {
  const release = work.repo ? site.releases[work.repo] : undefined;
  const parts = release ? [num(release.tag), `${time(release.publishedAt)} 发布`] : [];
  if (work.license) parts.push(licenses(work));
  return parts.length > 0 ? parts.join(SEP) : '已开源';
}

function workPage(site, to, work, ctx) {
  const open = work.status !== 'private';
  const caption = work.visual?.caption ? `\n<figcaption class="work-visual__caption">${keep(work.visual.caption)}</figcaption>` : '';
  // 手机上示意图按最小宽度显示（让图里最小的字不小于 14px），放不下就在容器里左右滑动（样式见 .work-visual__scroll）。
  // 容器加 tabindex 让键盘也能滑
  const visual = work.visual?.src
    ? `<figure class="work-visual"><div class="work-visual__scroll" role="group" aria-label="示意图" tabindex="0">${img(to, work.visual, work.visual.alt)}</div>${caption}</figure>`
    : '';
  // 开头只有一句介绍：它已经说了给谁用，works.json 的 audience 不再单独显示（免得和介绍重复）
  const highlights = work.highlights.length > 0 ? `${block({ id: 'highlights', title: '能做什么', body: points(work.highlights) })}\n` : '';
  return {
    title: `${work.name} · ${site.profile.name}`,
    description: work.summary,
    ld: workLd(site, work),
    body: `<article class="work-page">
${pageHead({ title: esc(work.name), titleAttrs: latin(work.name), sub: open ? esc(work.nameZh) : `${esc(work.nameZh)}${SEP}未开源` })}
${[`<p class="lead">${keep(work.summary)}</p>`, visual].filter(Boolean).join('\n')}
${highlights}${open ? `${block({ id: 'get', title: '怎么装', body: waysToGet(site, to, work, ctx) })}\n<p class="work-meta meta">${workMeta(site, work)}</p>` : ''}
</article>
<p class="page-end"><a class="text-link back" href="${to('/works/')}">${icon('back')}全部作品</a></p>`,
  };
}

// ---------- 播客 ----------

function podcastPage(site, to) {
  const { podcast, profile } = site;
  const missing = missingEpisodes(podcast);
  const wechat = profile.links.find((l) => l.label === '公众号');
  // 期数照来源写；站上列出的比来源少，就如实说少了几期、去哪听。少的不一定是较早的（撤下的可能是最新一期）
  const count = missing
    ? `共 ${num(podcast.episodeCount)} 期，另有 ${num(missing)} 期未在本站列出，可在<a class="inline-link" href="${esc(podcast.url)}">小宇宙</a>收听全部。`
    : `共 ${num(podcast.episodeCount)} 期`;
  const episodes = podcast.episodes.map((e) =>
    row({ date: e.pubDate, note: duration(e.duration), title: e.title, link: esc(e.url), external: true, ep: true }),
  );
  const listen = `<section id="listen" class="listen" aria-labelledby="page-title">
<div class="listen__head">
${img(to, COVER, `《${podcast.title}》节目封面`, { cls: 'listen__cover' })}
<div class="listen__title">
<h1 class="page-head__title" id="page-title">${esc(podcast.title)}</h1>
<p class="meta">${esc(profile.podcastAuthor)}${SEP}<span class="episode-count">${count}</span></p>
</div>
</div>
<p class="lead">${keep(profile.podcastIntro)}</p>
<p class="more"><a class="text-link" href="${esc(podcast.url)}">在小宇宙收听${icon('external')}</a></p>
${wechat ? `<p>${keep(`部分单集有文字版，发在公众号「${wechat.text}」。`)}</p>\n` : ''}${qrBlock(site, to)}
</section>`;
  return {
    title: `《${podcast.title}》 · 播客 · ${profile.name}`,
    description: profile.podcastIntro,
    ld: podcastLd(site),
    body: `${listen}
${block({ id: 'episodes', title: '全部单集', body: `<ol class="rows rows--episodes">\n${episodes.join('\n')}\n</ol>` })}`,
  };
}

// ---------- 关于 ----------

function aboutPage(site) {
  const { profile, works } = site;
  const [first] = profile.about;
  // 工具的问题到各自仓库的 Issue 页提：只列开源、有仓库的作品
  const repos = works.filter((w) => w.status !== 'private' && w.repo);
  const issues =
    repos.length > 0
      ? `\n<p class="find-me__issues">${keep('工具用着有问题：到对应的 GitHub 仓库提 Issue')}（${repos
          .map((w) => `<a class="inline-link" href="https://github.com/${GITHUB_OWNER}/${esc(w.repo)}/issues"${latin(w.name)}>${esc(w.name)}</a>`)
          .join('、')}）。</p>`
      : '';
  return {
    title: `关于 · ${profile.name}`,
    description: first,
    ld: personLd(site),
    body: `${pageHead({ title: '关于' })}
<div class="about__text">
${profile.about.map((p) => `<p>${keep(p).replaceAll(esc(`《${site.podcast.title}》`), (t) => `<span class="nobr">${t}</span>`)}</p>`).join('\n')}
</div>
${block({ id: 'find-me', title: '在哪找到我', body: `${contacts(profile)}${issues}` })}`,
  };
}

// ---------- 404 ----------

function notFoundPage(site, to) {
  return {
    title: `页面不存在 · ${site.profile.name}`,
    description: '这个地址没有内容。',
    body: `<section class="intro intro--404" aria-labelledby="page-title">
<p class="intro__code num" aria-hidden="true">404</p>
<h1 class="page-head__title" id="page-title">页面不存在</h1>
<p>这个地址没有内容。可以回<a class="inline-link" href="${to('/')}">首页</a>，或者看看<a class="inline-link" href="${to('/works/')}">作品</a>和<a class="inline-link" href="${to('/podcast/')}">播客</a>。</p>
</section>`,
  };
}

// ---------- 博客 ----------

function blogPage(site, to) {
  const { profile, posts } = site;
  const items = posts.map((p) => row({ date: p.date, title: p.title, link: to(postPath(p)), summary: p.summary }));
  return {
    title: `博客 · ${profile.name}`,
    description: `${profile.name} 的博客，共 ${posts.length} 篇。`,
    ld: blogLd(site),
    feed: true,
    body: `${pageHead({ title: '博客' })}
<ol class="rows rows--posts">
${items.join('\n')}
</ol>
<p class="more"><a class="text-link" href="${to('/blog/feed.xml')}">用 RSS 订阅博客${icon('arrow')}</a></p>`,
  };
}

function postPage(site, to, post) {
  // 正文里的图片多在首屏以下：一律懒加载（宽高由导入工具负责，样式保证不撑破版心）；
  // 代码块放不下时在框里横向滑动，加 tabindex 让键盘也能滑。
  // 文章标题已经是一级标题，正文里的标题整体降一级（# 变二级、## 变三级……），一页只有一个一级标题
  const html = post.html
    .trim()
    .replace(/<(\/?)h([1-5])\b/g, (_, slash, n) => `<${slash}h${Number(n) + 1}`)
    .replace(/<img\b/g, '<img loading="lazy" decoding="async"')
    .replace(/<pre>/g, '<pre tabindex="0">');
  return {
    title: `${post.title} · ${site.profile.name}`,
    description: post.summary || post.title,
    ld: postLd(site, post),
    feed: true,
    body: `<article class="post">
<header class="page-head">
<p class="post-meta meta">${time(post.date)}</p>
<h1 class="page-head__title" id="page-title">${esc(post.title)}</h1>
</header>
<div class="post-body prose">
${html}
</div>
</article>
<p class="page-end"><a class="text-link back" href="${to('/blog/')}">${icon('back')}全部文章</a></p>`,
  };
}

// ctx = {preview, version, downloads}：downloads 是构建时取到了的源码包文件名（Set），没取时是 null。
// 返回 [{path: 输出文件的相对路径, content}]
export function renderPages(site, ctx) {
  const pages = [
    ['/', 'home', (to) => homePage(site, to)],
    ['/works/', 'works', (to) => worksPage(site, to)],
    ...site.works.map((w) => [workPath(w), 'work', (to) => workPage(site, to, w, ctx)]),
    ['/podcast/', 'podcast', (to) => podcastPage(site, to)],
    ['/about/', 'about', () => aboutPage(site)],
    [NOT_FOUND, 'not-found', (to) => notFoundPage(site, to)],
  ];
  if (site.posts.length > 0) {
    pages.push(
      ['/blog/', 'blog', (to) => blogPage(site, to)],
      ...site.posts.map((p) => [postPath(p), 'post', (to) => postPage(site, to, p)]),
    );
  }
  return pages.map(([path, kind, page]) => ({ path: fileOf(path), content: layout(site, ctx, path, kind, page) }));
}
