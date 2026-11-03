// 解析一篇已发布的博客（content/blog/<slug>.md）：开头的 YAML 元数据只认 title、date、slug、summary 四个键，
// 每行一个“键: 值”，值可以加引号；正文用 marked 渲染成 HTML。date 存成 ISO UTC（没写时区按东八区）。
// 网站不加载外站资源、不跑 JS，所以正文里出现任何原始 HTML（标签、注释），链接地址不是 http(s):// 也不是相对地址
// （javascript:、data:、mailto: 这类），或图片不是相对地址（外站图片），这篇就不发。指向别的网站的普通网页链接可以。
// 图片照导入工具的约定和文章放在一起：content/blog/<slug>/x.png，正文写 ![](x.png)。
// 不发的情况（还有没有元数据、缺标题、日期认不出、slug 不安全——它会变成目录名）都抛 Error('BAD_POST')，带上文件名。
import { basename } from 'node:path';
import { marked } from 'marked';
import { parseDate } from './format.mjs';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// 相对地址按浏览器的规则解析后还落在这个假站点里；javascript:、//外站 这些都会跑出去
const BASE = new URL('https://post.invalid/blog/post/');

function isRelative(href) {
  try {
    return new URL(href, BASE).origin === BASE.origin;
  } catch {
    return false;
  }
}

const isWebLink = (href) => /^https?:\/\//i.test(href);

// marked 把地址里完整的字符引用（&colon;、&#58;、&#x09; 这类）原样写进属性，浏览器会再解码一次，
// 冒号和制表符就能藏过上面的检查。地址里有这种写法一律不收（正常网址用不到）。
const CHAR_REF = /&(?:#\d+|#x[0-9a-f]+|\w+);/i;

function isSafe(token) {
  if (token.type === 'html') return false;
  if (token.type !== 'link' && token.type !== 'image') return true;
  if (CHAR_REF.test(token.href)) return false;
  return token.type === 'link' ? isWebLink(token.href) || isRelative(token.href) : isRelative(token.href);
}

function readFrontMatter(block) {
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    let value = line.slice(colon + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[line.slice(0, colon).trim()] = value;
  }
  return meta;
}

export function parsePost(markdown, filename) {
  const bad = () => Object.assign(new Error('BAD_POST'), { file: filename });
  const text = markdown.replace(/^﻿/, '');
  const match = FRONT_MATTER.exec(text);
  if (!match) throw bad();
  const meta = readFrontMatter(match[1]);
  const slug = meta.slug || basename(filename, '.md');
  const time = parseDate(meta.date);
  if (!meta.title || Number.isNaN(time) || !SAFE_SLUG.test(slug)) throw bad();

  const tokens = marked.lexer(text.slice(match[0].length));
  if (marked.walkTokens(tokens, isSafe).includes(false)) throw bad();
  return {
    slug,
    title: meta.title,
    date: new Date(time).toISOString(),
    summary: meta.summary ?? '',
    html: marked.parser(tokens),
  };
}
