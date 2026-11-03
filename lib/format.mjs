// 日期、时长、HTML 转义和站内相对链接。
// 日期一律按东八区（UTC+8）显示为 YYYY-MM-DD；数据里存的是 ISO UTC。

const BEIJING = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNZONED = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/;

// 时间文字 → 毫秒数。写了时区的照原样；没写时区的一律按东八区（不随构建机的时区变）；
// 认不出的写法返回 NaN，不猜。
export function parseDate(text) {
  const s = String(text).trim();
  if (ZONED.test(s)) return Date.parse(s);
  const m = UNZONED.exec(s);
  return m ? Date.parse(`${m[1]}T${m[2] ?? '00:00'}+08:00`) : NaN;
}

export function formatDate(iso) {
  const parts = Object.fromEntries(BEIJING.formatToParts(new Date(parseDate(iso))).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 同一时刻改写成东八区的 ISO 写法，精确到秒（2026-09-06T17:20:00.269Z → 2026-09-07T01:20:00+08:00）：
// 给结构化数据用，只截日期的读者读到的和页面上显示的日期是同一天
export function isoBeijing(iso) {
  return `${new Date(parseDate(iso) + 8 * 3600 * 1000).toISOString().slice(0, 19)}+08:00`;
}

// 四舍五入到分钟；满 60 分钟写“H 小时 M 分钟”
export function formatDuration(sec) {
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function isoDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
  return `PT${parts || '0S'}`;
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// HTML 和 XML 通用
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// 站内链接：两个参数都是根路径（目录以 / 结尾），返回从 fromPath 所在目录出发的相对链接。
// preview 时目录链接补 index.html：私密预览的静态托管不一定认目录地址。
export function href(fromPath, toPath, { preview = false } = {}) {
  const fromDirs = fromPath.slice(0, fromPath.lastIndexOf('/') + 1).split('/').filter(Boolean);
  const toParts = toPath.split('/').filter(Boolean);
  const isDir = toPath.endsWith('/');
  const toDirs = isDir ? toParts : toParts.slice(0, -1);
  const fileName = isDir ? '' : toParts.at(-1);

  let common = 0;
  while (common < fromDirs.length && common < toDirs.length && fromDirs[common] === toDirs[common]) common += 1;
  const link =
    '../'.repeat(fromDirs.length - common) +
    toDirs
      .slice(common)
      .map((d) => `${d}/`)
      .join('') +
    fileName;

  if (isDir && preview) return `${link}index.html`;
  return link || './';
}
