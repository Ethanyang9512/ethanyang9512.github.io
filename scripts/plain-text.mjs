// 把页面 HTML 转成只读文字的读者看到的样子（抓网页的 AI、只取文字的工具的近似），用来查“字黏在一起”。
// 规则：只留 <title> 当第一行；去掉 <head> 其余部分、脚本、样式、注释和内联 SVG（图标、时长图都是图）；
// 块级元素（p、div、li、h1–h6、dt、dd 等）前后换行，标题前加 #，列表项前加 -；
// 行内元素（span、a、time、strong 等）只去标签，不补空白。所以模板里并排的文字之间要有真实的空格或分隔符，
// 不能只靠样式的间距分开，否则这里会读到“2026-09-2222 分钟”这样黏连的字。
// 用法：node scripts/plain-text.mjs <html 文件>，结果打印到标准输出。测试用 plainText() 检查黏连。
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'td', 'th', 'tr', 'ul',
]);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });

export function plainText(html) {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const text = html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ') // 源码里的换行和空白按 HTML 的规矩合成一个空格
    .replace(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi, (_, closing, tag) => {
      const name = tag.toLowerCase();
      if (name === 'br') return '\n';
      if (!BLOCK.has(name)) return ''; // 行内元素：只去标签
      if (closing) return '\n';
      if (/^h[1-6]$/.test(name)) return `\n${'#'.repeat(Number(name[1]))} `;
      return name === 'li' ? '\n- ' : '\n';
    });
  const lines = decode(text)
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .filter((l) => l && l !== '-');
  const out = [`页面标题：${decode(title).trim()}`, ''];
  for (const line of lines) {
    if (line.startsWith('#') && out.at(-1) !== '') out.push('');
    out.push(line);
  }
  return `${out.join('\n')}\n`;
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node scripts/plain-text.mjs <html 文件>');
    process.exitCode = 2;
  } else {
    process.stdout.write(plainText(await readFile(file, 'utf8')));
  }
}
