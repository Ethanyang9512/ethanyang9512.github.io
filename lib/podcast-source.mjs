// 解析小宇宙节目页里的 __NEXT_DATA__，只取白名单字段：
//   播客 {pid, title, episodeCount}，单集 {eid, title, pubDate, duration, url}。
// 只取白名单里的字段，其余一概不取。
// 报错只用错误码（NO_NEXT_DATA、PARSE、NO_EPISODES），不带原错误：
// Node 的 JSON 报错会带出页面片段，会进公开的 Actions 日志。

const NEXT_DATA = /<script\b[^>]*\bid=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i;
const ID = /^[0-9a-f]{24}$/;

const isId = (v) => typeof v === 'string' && ID.test(v);
const isText = (v) => typeof v === 'string' && v !== '';

function toEpisode(e) {
  const time = typeof e?.pubDate === 'string' ? Date.parse(e.pubDate) : NaN;
  if (!isId(e?.eid) || !isText(e.title) || Number.isNaN(time) || !Number.isInteger(e.duration) || e.duration < 0) {
    throw new Error('PARSE');
  }
  return {
    eid: e.eid,
    title: e.title,
    pubDate: new Date(time).toISOString(),
    duration: e.duration,
    url: `https://www.xiaoyuzhoufm.com/episode/${e.eid}`,
  };
}

export function parsePodcastPage(html) {
  const match = NEXT_DATA.exec(html);
  if (!match) throw new Error('NO_NEXT_DATA');
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('PARSE');
  }
  const p = data?.props?.pageProps?.podcast;
  if (!p || typeof p !== 'object') throw new Error('PARSE');
  if (!Array.isArray(p.episodes) || p.episodes.length === 0) throw new Error('NO_EPISODES');
  if (!isId(p.pid) || !isText(p.title) || !Number.isInteger(p.episodeCount) || p.episodeCount < 0) {
    throw new Error('PARSE');
  }
  return {
    podcast: { pid: p.pid, title: p.title, episodeCount: p.episodeCount },
    episodes: p.episodes.map(toEpisode),
  };
}
