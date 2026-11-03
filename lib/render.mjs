// 各页的 HTML 模板。只出静态 HTML：不加载外站资源、不跑 JS，关掉 JS 也能读到全部正文。
// 版式是瑞士风格的网格，样式全在 assets/site.css：12 栏网格，电脑上左 3 栏是“索引栏”（区块编号和标题），
// 右 9 栏是内容；整页只有一个高亮色，以红色方块出现，只标记“现在 / 最新”。
// 结构约定（测试靠这些找内容，换皮时请保留）：正文在 <main>，导航在 <nav>；首页 section#intro、#works、
// #latest-episode、#updates；/podcast/ 页 section#listen、#episodes；开源作品的作品页 section#get（获取方式，
// 暂未开源的作品页没有这一块）；/about/ 页 section#find-me、#this-site。
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

const fileOf = (path) => (path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1));

// ---------- 小部件 ----------

// 图标：站内 →、站外 ↗、下载 ↓（带底线）、跳到本页下文 ↓、返回 ←；线宽固定，跟着字号缩放
const ICON_PATHS = {
  arrow: 'M1.5 8h12.5M9 3.5 13.5 8 9 12.5',
  external: 'M3.5 12.5 12.5 3.5M5.5 3.5h7v7',
  download: 'M8 1.5v10M3.5 7.5 8 12l4.5-4.5M2.5 14.5h11',
  down: 'M8 1.5v12.5M3.5 9 8 13.5 12.5 9',
  back: 'M14.5 8H2M7 3.5 2.5 8 7 12.5',
};
const icon = (name) =>
  `<svg class="icon icon--${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}" vector-effect="non-scaling-stroke"/></svg>`;

// 红色方块：全站唯一的高亮色，只标记“现在 / 最新”（名字的句点、最新一期、最近一次更新）
const SQUARE = '<span class="square" aria-hidden="true"></span>';

// 纯拉丁字母的名字标上 lang="en"：读屏按英文念，字体按拉丁字走
const latin = (text) => (/^[\x20-\x7e]+$/.test(text) ? ' lang="en"' : '');

// 数字类（日期、版本号、条数和时长里的数字）用等宽字体，汉字和英文标签用正文字体
const num = (text) => `<span class="num">${esc(text)}</span>`;
const nums = (text) => esc(text).replace(/\d+/g, (d) => `<span class="num">${d}</span>`);
const time = (iso) => `<time class="num" datetime="${formatDate(iso)}">${formatDate(iso)}</time>`;
const duration = (sec) => nums(formatDuration(sec));

// 不拆开的词：正文按字断行时，词表里的词整个挪到下一行，不断成“一 / 个”“小红 / 书”。
// keep(文字) 先转义，再给词表里的词包上不换行的 span，不加不减任何字，只读文字的读者看到的还是原句。
// 只用在作者自己写的正文上；单集标题、安装命令这类照原样放的整句不包，免得拆开原文
const KEEP_WORDS = [
  '一个', '个人', '可以', '链接', '智能体', '小红书', '公众号', '小宇宙', '录音', '格式', '示意图', '版本号', 'GitHub 上', 'Claude Code',
  '检查', '第三方', '剪辑', '程序', '验收员', '飞书', '汇报片', '一路',
];
const KEEP = new RegExp(KEEP_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
export const keep = (text) => esc(text).replace(KEEP, (w) => `<span class="nobr">${w}</span>`);

// 区块开头（全站统一）：1px 黑线 + 编号 + 区块标题；电脑上挂在左边三栏，滚动时停在顶部
function sectionHead(n, id, title) {
  return `<div class="section__head">
<span class="section__num num">${String(n).padStart(2, '0')}</span>
<h2 class="section__title" id="${id}">${title}</h2>
</div>`;
}

const img = (to, { src, width, height }, alt, { lazy = false, cls = '' } = {}) =>
  `<img${cls ? ` class="${cls}"` : ''} src="${to(src)}"${width ? ` width="${width}" height="${height}"` : ''} alt="${esc(alt)}"${lazy ? ' loading="lazy"' : ''} decoding="async">`;

// 二维码：扫出来是节目主页。四周 16px 白边（大于边长的 10%）；手机上扫不了自己的屏幕，样式里只在平板和电脑上显示
function qrBlock(site, to, cls) {
  const { title } = site.podcast;
  return `<div class="qr ${cls}">
<span class="qr__box"><img src="${to(QR.src)}" width="${QR.size}" height="${QR.size}" alt="扫码打开小宇宙上的《${esc(title)}》节目页" loading="lazy" decoding="async"></span>
<p class="qr__caption" aria-hidden="true">扫码打开小宇宙节目页</p>
</div>`;
}

// 许可证照 works.json 里的名字写。代码和文档分开授权（有 docsLicense）的写“代码 MIT、文档 CC BY 4.0”，
// 两半各自不拆开：规格表那一栏窄，放不下时在“、”后面换行，不把“文档”和许可证名拆到两行。返回 HTML
const nobr = (text) => `<span class="nobr">${esc(text)}</span>`;
const licenses = (work) =>
  work.docsLicense ? `${nobr(`代码 ${work.license}`)}、${nobr(`文档 ${work.docsLicense}`)}` : esc(work.license);

// 规格表里的状态，返回 HTML
function status(work) {
  if (work.status === 'private') return '暂未开源';
  if (!work.license) return '已开源';
  return work.docsLicense ? `已开源，${licenses(work)}` : `已开源，${licenses(work)} 许可证`;
}

// WorkBuddy 的一句话定义，依据作品 README 的公开说法（腾讯 WorkBuddy 客户端；在技能市场、专家市场里搜名字；
// 专家团装好就能用、在云端运行）。列表里有专家团才提专家团
function workbuddyDefinition(items) {
  return items.some((i) => i.type === '专家团')
    ? 'WorkBuddy 是腾讯的 AI 客户端，技能在它的技能市场里、专家团在专家市场里，搜名字就能装。技能是单个能力，专家团是一组协作的 AI，装好在云端运行。'
    : 'WorkBuddy 是腾讯的 AI 客户端，技能在它的技能市场里，搜名字就能装。';
}

// 规格表：一行一项，标签在左、数值在右。数据里有什么才写什么（暂未开源的作品只有“状态”一行）
function specRows(site, work) {
  const rows = [['状态', status(work)]];
  const release = work.repo ? site.releases[work.repo] : undefined;
  if (release) rows.push(['版本', num(release.tag)], ['发布', time(release.publishedAt)]);
  const items = work.workbuddy?.items ?? [];
  if (items.length > 0) rows.push(['WorkBuddy', `已公开 ${num(items.length)} 项`]);
  return `<dl class="spec">
${rows.map(([dt, dd]) => `<div><dt>${dt}</dt> <dd>${dd}</dd></div>`).join('\n')}
</dl>`;
}

const sourceLink = (work) =>
  work.status !== 'private' && work.repo
    ? `<a class="text-link work__source" href="https://github.com/${GITHUB_OWNER}/${esc(work.repo)}">查看源码${icon('external')}</a>`
    : '';

// 一件作品：名字、中文名、做什么（整块是进作品页的链接），右边规格表和源码链接
function workItem(site, to, work, heading) {
  return `<a class="work__link" href="${to(workPath(work))}">
<${heading} class="work__name"><span class="work__name-text"${latin(work.name)}>${esc(work.name)}</span>${icon('arrow')}</${heading}>
<p class="work__zh">${esc(work.nameZh)}</p>
<p class="work__desc">${keep(work.summary)}</p>
</a>
<div class="work__aside">
${specRows(site, work)}
${sourceLink(work)}
</div>`;
}

// 列表的一行：一行小号元信息（日期、类型或时长），一行标题。只有标题是链接文字，样式把点按范围铺满整行。
// 单集标题常驻一条细下划线（它就是“听”的按钮）；最新的一条前面挂红方块
// note 是这一行的第二项元信息（类型或时长），调用方给的是已转义的 HTML
function row({ date, note = '', title, link, external = false, latest = false, ep = false, summary = '' }) {
  return `<li class="row${latest ? ' row--latest' : ''}">
<span class="row__when"><span class="square row__marker" aria-hidden="true"></span>${time(date)}</span>
${note ? `<span class="row__note">${note}</span>\n` : ''}<p class="row__title"><a class="row__link${ep ? ' ep-link' : ''}" href="${link}"><span class="row__label">${esc(title)}</span>${icon(external ? 'external' : 'arrow')}</a></p>
${summary ? `<p class="row__summary">${esc(summary)}</p>\n` : ''}</li>`;
}

// 单集时长图：每期一个方块，按期排列（旧的在左、每期一格，不是日历时间），高度和时长成正比，从 0 起；
// 最新一期是红方块。坐标在构建时由单集数据算出，不手写；每个方块带日期和时长的提示，不放单集标题。
// 图上没有刻度，所以在图注下面写出最短、最长各几分钟（同样由数据算）。
function durationChart(episodes, cls = '') {
  if (episodes.length === 0) return '';
  const eps = [...episodes].reverse();
  const W = 272;
  const BASE = 99;
  const slot = W / eps.length;
  const size = Math.max(3, Math.min(9, Math.floor(slot * 0.6)));
  const minutes = eps.map((e) => Math.round(e.duration / 60));
  const max = Math.max(1, ...minutes);
  const r = (v) => Math.round(v * 10) / 10;
  const stems = [];
  const dots = eps.map((e, i) => {
    const cx = r(slot * (i + 0.5));
    const top = r(BASE - (minutes[i] / max) * (BASE - size / 2));
    stems.push(`M${cx} ${BASE}V${top}`);
    const latest = i === eps.length - 1 ? ' class="dotplot__latest"' : '';
    return `<rect${latest} x="${r(cx - size / 2)}" y="${r(top - size / 2)}" width="${size}" height="${size}"><title>${formatDate(e.pubDate)} · ${formatDuration(e.duration)}</title></rect>`;
  });
  const sec = eps.map((e) => e.duration);
  const label =
    `${eps.length} 期单集的时长，按期排列：最短 ${formatDuration(Math.min(...sec))}，` +
    `最长 ${formatDuration(Math.max(...sec))}，最新一期 ${formatDuration(sec.at(-1))}`;
  return `<figure class="dotplot${cls ? ` ${cls}` : ''}">
<figcaption class="dotplot__caption"><span>单集时长</span> <span>按期排列</span></figcaption>
<p class="dotplot__range">最短 ${duration(Math.min(...sec))} <span class="sep" aria-hidden="true">·</span> 最长 ${duration(Math.max(...sec))}</p>
<svg class="dotplot__svg" viewBox="0 0 ${W} 100" role="img" aria-label="${esc(label)}">
<path class="dotplot__base" d="M0 99.5H${W}"/>
<path class="dotplot__stems" d="${stems.join('')}"/>
<g class="dotplot__dots">
${dots.join('\n')}
</g>
</svg>
<p class="dotplot__axis"><span>最早一期 ${time(eps[0].pubDate)}</span> <span>最新一期 ${time(eps.at(-1).pubDate)}</span></p>
</figure>`;
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
    '<meta name="theme-color" content="#fafaf8">',
    `<link rel="icon" href="${to('/assets/favicon.svg')}" type="image/svg+xml">`,
    `<link rel="stylesheet" href="${to('/assets/site.css')}">`,
    ...(feed ? [`<link rel="alternate" type="application/rss+xml" title="${esc(profile.name)} 的博客" href="${to('/blog/feed.xml')}">`] : []),
    ...(ld ? [ldScript(ld)] : []),
  ];
  const mark = `<span${latin(profile.name)}>${esc(profile.name)}</span>${SQUARE}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
${head.join('\n')}
</head>
<body class="page-${kind}">
${notFound ? '' : '<a class="skip-link" href="#main">跳到正文</a>\n'}<header class="site-header">
<div class="wrap site-header__inner">
<a class="site-mark" href="${to('/')}">${mark}</a>
<nav class="site-nav" aria-label="栏目">
<ul>
${nav.join('\n')}
</ul>
</nav>
</div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
<div class="wrap">
<div class="footer__base">
<p class="footer__mark">${mark}</p>
<p class="footer__license">网站文字 ${esc(profile.license)}，转载请署名 ${esc(profile.name)} 并附链接；代码 MIT</p>
</div>
</div>
</footer>
</body>
</html>
`;
}

// 栏目页和详情页的页头：大标题压在版心左线上，下面一条黑线，再分索引栏和内容栏（和首页首屏同一个结构）。
// body 是黑线下面那个网格里的各块，按手机上从上到下的顺序给；电脑上各块放进哪几栏由样式定
function masthead({ id = 'page-title', sectionId = '', eyebrow = '', title, titleAttrs = '', sub = '', body = '', cls = '', tag = 'section' }) {
  return `<${tag}${sectionId ? ` id="${sectionId}"` : ''} class="masthead${cls ? ` ${cls}` : ''}"${tag === 'section' ? ` aria-labelledby="${id}"` : ''}>
<div class="wrap">
${eyebrow ? `<p class="masthead__eyebrow">${eyebrow}</p>\n` : ''}<h1 class="masthead__title" id="${id}"${titleAttrs}>${title}</h1>
${sub ? `<p class="masthead__sub">${sub}</p>\n` : ''}${body ? `<div class="masthead__body grid">\n${body}\n</div>\n` : ''}</div>
</${tag}>`;
}

// 一个编号区块：索引栏放编号和标题（可再加一块，比如时长图），内容栏放正文
function section({ id, n, title, body, aside = '', cls = '' }) {
  const headId = `${id}-title`;
  return `<section id="${id}" class="section${cls ? ` ${cls}` : ''}" aria-labelledby="${headId}">
<div class="wrap">
<div class="section__grid grid">
<div class="section__aside">
${sectionHead(n, headId, title)}${aside ? `\n${aside}` : ''}
</div>
<div class="section__main">
${body}
</div>
</div>
</div>
</section>`;
}

// ---------- 首页 ----------

// 单集、版本、博客按日期倒序合并，取前 5 条
function recentUpdates(site, to) {
  const releases = site.works
    .filter((w) => site.releases[w.repo])
    .map((w) => {
      const r = site.releases[w.repo];
      return { date: r.publishedAt, note: '版本', title: `${w.name} ${r.tag}`, link: to(workPath(w)) };
    });
  const items = [
    ...site.podcast.episodes.map((e) => ({ date: e.pubDate, note: '播客', title: e.title, link: esc(e.url), external: true, ep: true })),
    ...releases,
    ...site.posts.map((p) => ({ date: p.date, note: '博客', title: p.title, link: to(postPath(p)) })),
  ];
  return items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 5);
}

// 一句话介绍按逗号、分号分成几行（每个分句一行，电脑和手机上都一样）
const clauses = (text) =>
  text
    .split(/(?<=[，；])/)
    .map((c) => `<span class="hero__clause">${esc(c)}</span>`)
    .join('');

function homePage(site, to) {
  const { profile, podcast } = site;
  const latest = podcast.episodes[0];
  const hero = `<section id="intro" class="hero" aria-labelledby="intro-title">
<div class="wrap">
<h1 class="hero__name" id="intro-title"><span${latin(profile.name)}>${esc(profile.name)}</span>${SQUARE}</h1>
<div class="hero__body grid">
<div class="hero__text">
<p class="hero__intro">${clauses(profile.tagline)}</p>
<p class="hero__lead">${keep(profile.intro)}</p>
</div>
<ul class="hero__entries">
<li><a class="entry" href="${to('/works/')}"><span>看作品</span>${icon('arrow')}</a></li>
<li><a class="entry" href="${to('/podcast/')}"><span>听播客</span>${icon('arrow')}</a></li>
</ul>
</div>
</div>
</section>`;

  const works = section({
    id: 'works',
    n: 1,
    title: '作品',
    body: `<ol class="work-list">
${site.works.map((w) => `<li class="work">\n${workItem(site, to, w, 'h3')}\n</li>`).join('\n')}
</ol>`,
  });

  // 02 播客：黑色通栏。最新一期的标题就是“听”的按钮；时长图在电脑上挂在索引栏
  const band = latest
    ? `<section id="latest-episode" class="section section--band podcast" aria-labelledby="podcast-title">
<div class="wrap">
<div class="section__grid grid podcast__grid">
<div class="section__aside">
${sectionHead(2, 'podcast-title', '播客')}
</div>
<div class="section__main podcast__body">
<div class="podcast__latest">
<p class="podcast__eyebrow">${SQUARE}最新一期</p>
<h3 class="podcast__ep-title"><a class="ep-link" href="${esc(latest.url)}"><span class="ep-link__text">${esc(latest.title)}</span>${icon('external')}</a></h3>
<p class="meta podcast__ep-meta">${time(latest.pubDate)} <span>${duration(latest.duration)}</span></p>
<p class="podcast__actions"><a class="button" href="${esc(podcast.url)}">在小宇宙收听全部节目${icon('external')}</a> <a class="text-link" href="${to('/podcast/')}">全部单集${icon('arrow')}</a></p>
</div>
${qrBlock(site, to, 'podcast__qr')}
<div class="podcast__show">
${img(to, COVER, `《${podcast.title}》节目封面`, { lazy: true, cls: 'podcast__cover' })}
<div class="podcast__info">
<h3 class="podcast__name">${esc(podcast.title)}</h3>
<p class="meta podcast__host">${esc(profile.podcastAuthor)} · 共 ${num(podcast.episodeCount)} 期</p>
</div>
<p class="podcast__desc">${esc(profile.podcastIntro)}</p>
</div>
</div>
${durationChart(podcast.episodes, 'podcast__chart')}
</div>
</div>
</section>`
    : '';

  const updates = recentUpdates(site, to).map((u, i) => row({ ...u, latest: i === 0 }));
  const updatesSection = section({
    id: 'updates',
    n: latest ? 3 : 2,
    title: '最近更新',
    body: `<ol class="rows">\n${updates.join('\n')}\n</ol>`,
  });

  // 04 关于：“关于”正文的最后一段，加“联系方式”
  const contact = section({
    id: 'contact',
    n: latest ? 4 : 3,
    title: '关于',
    body: `<p class="about__lead">${keep(profile.about.at(-1))}</p>\n${contacts(profile)}`,
  });

  return {
    title: profile.name,
    description: profile.tagline,
    ld: personLd(site),
    body: [hero, works, band, updatesSection, contact].filter(Boolean).join('\n'),
  };
}

// 联系方式：GitHub、小宇宙可点；公众号没有链接，写明在微信里怎么找
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
  const open = works.filter((w) => w.status !== 'private').length;
  const listed = works.flatMap((w) => w.workbuddy?.items ?? []);
  // 页头一行数字：都从数据数出来（WorkBuddy 只收了状态为“公开发布”的项）；有 WorkBuddy 的项，下面跟一句它是什么
  const facts = [`共 ${num(works.length)} 件`, `已开源 ${num(open)} 件`, ...(listed.length > 0 ? [`WorkBuddy 已公开 ${num(listed.length)} 项`] : [])];
  const note = listed.length > 0 ? `\n<p class="masthead__note">${keep(workbuddyDefinition(listed))}</p>` : '';
  const items = works.map(
    (w, i) => `<li class="catalogue__item grid">
<p class="catalogue__index num">${String(i + 1).padStart(2, '0')}</p>
<div class="work">
${workItem(site, to, w, 'h2')}
</div>
</li>`,
  );
  return {
    title: `作品 · ${profile.name}`,
    description: `${profile.name} 做的 ${works.length} 件作品：${works.map((w) => w.name).join('、')}。`,
    ld: worksLd(site),
    body: `${masthead({ title: '作品', body: `<p class="masthead__facts">${facts.join(' <span class="sep" aria-hidden="true">·</span> ')}</p>${note}`, cls: 'masthead--works' })}
<div class="wrap">
<ol class="catalogue">
${items.join('\n')}
</ol>
</div>`,
  };
}

// 亮点：开头是一个短的小标题加冒号（“数字靠得住：……”）时把小标题加重；
// 只有整张列表每一条都这样写才加重，不然一律不加，免得同一张表里有的加粗有的没有
const LEAD_IN = /^([^：]{2,12})：([\s\S]+)$/;
function points(highlights) {
  const leads = highlights.map((h) => LEAD_IN.exec(h));
  const bold = leads.every(Boolean);
  const items = highlights.map((text, i) => {
    const body = bold ? `<span class="point__lead">${keep(leads[i][1])}：</span>${keep(leads[i][2])}` : keep(text);
    return `<li class="point"><span class="point__num num">${String(i + 1).padStart(2, '0')}</span> <p class="point__text">${body}</p></li>`;
  });
  return `<ol class="points">\n${items.join('\n')}\n</ol>`;
}

// 下载按钮的地址：没取源码包（ctx.downloads 是 null，比如预览）时直接指向 GitHub 的源码包；
// 取了的指向本站 downloads/；构建时没取到的返回 null，不放按钮，也不链到取不到的地址
function downloadLink(to, release, ctx) {
  if (!ctx.downloads) return esc(release.zipUrl);
  return ctx.downloads.has(release.zipName) ? to(`/downloads/${release.zipName}`) : null;
}

// 获取方式（只有开源的作品才有这一块）：最省事的在前。①装进 Claude Code；②在 WorkBuddy 安装；
// ③在 GitHub 看源码、下载源码包。有哪个才显示哪个
function waysToGet(site, to, work, ctx) {
  const ways = [];
  const commands = work.install?.claudeCode ?? [];
  if (commands.length > 0) {
    ways.push(`<li class="way way-claude-code"><p class="way__title">装进 Claude Code</p>
<p class="way-note">${keep('先装好 Anthropic 的 AI 编程助手 Claude Code，再在里面依次输入：')}</p>
<pre class="code" tabindex="0"><code>${commands.map(esc).join('\n')}</code></pre></li>`);
  }
  const items = work.workbuddy?.items ?? [];
  if (items.length > 0) {
    ways.push(`<li class="way way-workbuddy"><p class="way__title">在 WorkBuddy 安装</p>
<p class="way-note">${keep(workbuddyDefinition(items))}</p>
<ul class="workbuddy-items">
${items.map((i) => `<li>${esc(i.name)}<span class="workbuddy-items__type">（${esc(i.type)}）</span></li>`).join('\n')}
</ul></li>`);
  }
  if (work.repo) {
    ways.push(`<li class="way way-github"><a class="way__action" href="https://github.com/${GITHUB_OWNER}/${esc(work.repo)}"><span class="way__label">在 GitHub 看源码</span>${icon('external')}</a></li>`);
  }
  const release = work.repo ? site.releases[work.repo] : undefined;
  const link = release ? downloadLink(to, release, ctx) : null;
  if (link) {
    ways.push(`<li class="way way-download"><a class="way__action" href="${link}"><span class="way__label">下载源码包</span> <span class="way__file num">${esc(release.zipName)}</span>${icon('download')}</a>
<p class="way-note">${num(release.tag)}，${time(release.publishedAt)} 发布。${keep('就是 GitHub 上这个版本的完整源码，下载后照包里的 README 安装。')}</p></li>`);
  }
  const license = work.license ? `\n<p class="license">许可：${licenses(work)}</p>` : '';
  return `<ul class="ways">\n${ways.join('\n')}\n</ul>${license}`;
}

function workPage(site, to, work, ctx) {
  const index = site.works.indexOf(work) + 1;
  const open = work.status !== 'private';
  const caption = work.visual?.caption ? `\n<figcaption class="work-visual__caption">${keep(work.visual.caption)}</figcaption>` : '';
  // 手机上示意图按最小宽度显示（让图里最小的字不小于 14px），放不下就在容器里左右滑动（样式见 .work-visual__scroll）。
  // 容器加 tabindex 让键盘也能滑；提示只给看得见的人，读屏不念（aria-hidden），窄屏以外样式把它藏起来
  const visual = work.visual?.src
    ? `<figure class="work-visual"><div class="work-visual__scroll" role="group" aria-label="示意图" tabindex="0">${img(to, work.visual, work.visual.alt)}</div>
<p class="work-visual__hint" aria-hidden="true">左右滑动看全图</p>${caption}</figure>`
    : '';
  // 暂未开源的作品没有“获取方式”：状态写在规格表里，不另起一块只写“暂未开源”的区块
  const sections = [
    ['audience', '适合谁', `<p class="work-audience__text">${keep(work.audience)}</p>`],
    ['highlights', '能做什么', points(work.highlights)],
    ...(open ? [['get', '获取方式', waysToGet(site, to, work, ctx)]] : []),
  ];
  // 页头规格表旁：跳到本页“获取方式”的链接（在查看源码前面），只有开源的作品有
  const jump = open ? `<a class="text-link work-page__jump" href="#get">获取方式${icon('down')}</a>` : '';
  return {
    title: `${work.name} · ${site.profile.name}`,
    description: work.summary,
    ld: workLd(site, work),
    // 页头：手机上依次是一句话、规格表、示意图；电脑上规格表在索引栏，一句话和示意图在内容栏
    body: `<article class="work-page">
${masthead({
  tag: 'div',
  eyebrow: `<a class="text-link" href="${to('/works/')}">作品</a> <span class="num">${String(index).padStart(2, '0')} / ${String(site.works.length).padStart(2, '0')}</span>`,
  title: esc(work.name),
  titleAttrs: latin(work.name),
  sub: esc(work.nameZh),
  body: [
    `<p class="lead work-page__lead">${keep(work.summary)}</p>`,
    `<div class="work-page__facts">\n${[specRows(site, work), jump, sourceLink(work)].filter(Boolean).join('\n')}\n</div>`,
    visual,
  ]
    .filter(Boolean)
    .join('\n'),
  cls: 'masthead--work',
})}
${sections.map(([id, title, body], i) => section({ id, n: i + 1, title, body, cls: `work-${id}` })).join('\n')}
</article>
<div class="wrap page-end"><a class="text-link back" href="${to('/works/')}">${icon('back')}全部作品</a></div>`,
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
  const episodes = podcast.episodes.map((e, i) =>
    row({ date: e.pubDate, note: duration(e.duration), title: e.title, link: esc(e.url), external: true, ep: true, latest: i === 0 }),
  );
  // 黑色通栏的页头就是“怎么收听”：封面、简介、收听按钮、提示、二维码
  const listen = masthead({
    sectionId: 'listen',
    eyebrow: '播客',
    title: esc(podcast.title),
    cls: 'masthead--band listen',
    body: `${img(to, COVER, `《${podcast.title}》节目封面`, { cls: 'listen__cover' })}
<div class="listen__main">
<p class="meta listen__host">${esc(profile.podcastAuthor)} <span class="sep" aria-hidden="true">·</span> <span class="episode-count">${count}</span></p>
<p class="lead">${keep(profile.podcastIntro)}</p>
<p class="listen__actions"><a class="button" href="${esc(podcast.url)}">在小宇宙收听全部节目${icon('external')}</a></p>
<ul class="listen__tips">
<li>点下面任意一期的标题，会打开这一期在小宇宙的网页，不用登录就能直接播放。</li>
${wechat ? `<li>${keep(`部分单集有文字版，发在公众号「${wechat.text}」。`)}</li>\n` : ''}</ul>
</div>
${qrBlock(site, to, 'listen__qr')}`,
  });
  return {
    title: `《${podcast.title}》 · 播客 · ${profile.name}`,
    description: profile.podcastIntro,
    ld: podcastLd(site),
    body: `${listen}
${section({
  id: 'episodes',
  n: 1,
  title: '全部单集',
  aside: durationChart(podcast.episodes),
  body: `<ol class="rows rows--episodes">\n${episodes.join('\n')}\n</ol>`,
})}`,
  };
}

// ---------- 关于 ----------

// 关于这个网站：放什么、怎么更新、文字的许可。只写事实（依据：站点 README、工作流、LICENSE-docs），不写经历
function aboutSite(site) {
  const { profile, podcast, posts } = site;
  const what =
    posts.length > 0
      ? `我的作品、博客和播客《${podcast.title}》的单集列表`
      : `我的作品和播客《${podcast.title}》的单集列表，以后也放博客`;
  return (
    `这个网站放${what}。单集列表和作品的版本号，每天自动从小宇宙和 GitHub 同步一次。` +
    `网站文字和自绘的示意图按 ${profile.license} 授权：可以转载、改编，请署名 ${profile.name} 并附上原文链接；播客封面不在授权范围内。`
  );
}

function aboutPage(site) {
  const { profile, works } = site;
  const [first, ...rest] = profile.about;
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
    body: `${masthead({
      title: '关于',
      body: `<div class="about__text">\n<p class="lead">${keep(first)}</p>\n${rest.map((p) => `<p>${keep(p)}</p>`).join('\n')}\n</div>`,
      cls: 'masthead--about',
    })}
${section({ id: 'find-me', n: 1, title: '在哪找到我', body: `${contacts(profile)}${issues}` })}
${section({ id: 'this-site', n: 2, title: '这个网站', body: `<p class="about__site">${keep(aboutSite(site))}</p>` })}`,
  };
}

// ---------- 404 ----------

function notFoundPage(site, to) {
  return {
    title: `页面不存在 · ${site.profile.name}`,
    description: '这个地址没有内容。',
    body: `<section class="hero hero--404" aria-labelledby="page-title">
<div class="wrap">
<p class="hero__name" aria-hidden="true"><span lang="en">404</span></p>
<div class="hero__body grid">
<div class="hero__text">
<h1 class="hero__intro" id="page-title">页面不存在</h1>
<p class="hero__lead">这个地址没有内容。可以回<a class="inline-link" href="${to('/')}">首页</a>，或者看看<a class="inline-link" href="${to('/works/')}">作品</a>和<a class="inline-link" href="${to('/podcast/')}">播客</a>。</p>
</div>
</div>
</div>
</section>`,
  };
}

// ---------- 博客 ----------

function blogPage(site, to) {
  const { profile, posts } = site;
  const items = posts.map((p, i) => row({ date: p.date, title: p.title, link: to(postPath(p)), summary: p.summary, latest: i === 0 }));
  return {
    title: `博客 · ${profile.name}`,
    description: `${profile.name} 的博客，共 ${posts.length} 篇。`,
    ld: blogLd(site),
    feed: true,
    body: `${masthead({ title: '博客', body: `<p class="masthead__facts">共 ${num(posts.length)} 篇</p>`, cls: 'masthead--blog' })}
${section({
  id: 'posts',
  n: 1,
  title: '全部文章',
  body: `<ol class="rows rows--posts">
${items.join('\n')}
</ol>
<p class="feed-link"><a class="text-link" href="${to('/blog/feed.xml')}">用 RSS 订阅博客${icon('arrow')}</a></p>`,
})}`,
  };
}

function postPage(site, to, post) {
  // 正文里的图片多在首屏以下：一律懒加载（宽高由导入工具负责，样式保证不撑破版心）；
  // 代码块放不下时在框里横向滑动，加 tabindex 让键盘也能滑
  const html = post.html
    .trim()
    .replace(/<img\b/g, '<img loading="lazy" decoding="async"')
    .replace(/<pre>/g, '<pre tabindex="0">');
  return {
    title: `${post.title} · ${site.profile.name}`,
    description: post.summary || post.title,
    ld: postLd(site, post),
    feed: true,
    body: `<article class="post">
<div class="masthead masthead--post">
<div class="wrap">
<p class="masthead__eyebrow post-meta">${time(post.date)}</p>
<h1 class="masthead__title">${esc(post.title)}</h1>
</div>
</div>
<div class="wrap">
<div class="post-grid grid">
<div class="post-body prose">
${html}
</div>
</div>
</div>
</article>
<div class="wrap page-end"><a class="text-link back" href="${to('/blog/')}">${icon('back')}全部文章</a></div>`,
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
