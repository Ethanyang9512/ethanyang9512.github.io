import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost } from '../lib/blog.mjs';

const FRONT = '---\ntitle: 夹具\ndate: 2026-03-01\n---\n\n';

test('parsePost reads front matter and renders the body', () => {
  const md = '---\ntitle: "夹具：A & B"\ndate: 2026-03-01\nslug: fixture-post\nsummary: 一句话摘要\n---\n\n正文**加粗**。\n';

  const { html, ...meta } = parsePost(md, 'whatever.md');

  // 只写日期没写时区：按东八区当天零点，存成 ISO UTC
  assert.deepEqual(meta, {
    slug: 'fixture-post',
    title: '夹具：A & B',
    date: '2026-02-28T16:00:00.000Z',
    summary: '一句话摘要',
  });
  assert.equal(html, '<p>正文<strong>加粗</strong>。</p>\n');
});

test('slug falls back to the file name', () => {
  const post = parsePost(`${FRONT}正文\n`, '2026-03-01-2.md');
  assert.equal(post.slug, '2026-03-01-2');
  assert.equal(post.summary, '');
});

test('post without title or date, or with an unsafe slug, is rejected', () => {
  // slug 会变成目录名，只收字母、数字、横线和下划线
  const bad = [
    ['正文，没有开头的元数据\n', 'a.md'],
    ['---\ndate: 2026-03-01\n---\n正文\n', 'a.md'],
    ['---\ntitle: 夹具\ndate: 不是日期\n---\n正文\n', 'a.md'],
    ['---\ntitle: 夹具\ndate: 2026-03-01\nslug: ../escape\n---\n正文\n', 'a.md'],
    [`${FRONT}正文\n`, '有 空格.md'],
  ];
  for (const [md, file] of bad) {
    assert.throws(() => parsePost(md, file), (err) => err.message === 'BAD_POST' && err.file === file, `${file}: ${md}`);
  }
});

test('post with raw HTML, unsafe links or outside images is rejected', () => {
  // 网站不加载外站资源、不跑 JS：文章里出现任何原始 HTML、非网页链接或外站图片，这篇就不发
  const bad = {
    外站脚本: '<script src="https://cdn.example.invalid/x.js"></script>\n',
    内嵌网页: '<iframe src="https://example.invalid/"></iframe>\n',
    带事件的图片: '<img src="figure.png" onerror="alert(1)">\n',
    行内标签: '正文里夹一个 <b>标签</b>。\n',
    注释: '<!-- 一段注释 -->\n',
    脚本链接: '[点我](javascript:alert(1))\n',
    大小写混写的脚本链接: '[点我](JaVaScRiPt:alert(1))\n',
    引用式的脚本链接: '[点我][x]\n\n[x]: javascript:alert(1)\n',
    数据链接: '[点我](data:text/html,夹具)\n',
    邮件链接: '[写信](mailto:)\n',
    协议相对的链接: '[点我](//example.invalid/)\n',
    外站图片: '![图](https://img.example.invalid/x.png)\n',
    协议相对的外站图片: '![图](//img.example.invalid/x.png)\n',
    // marked 会把地址里完整的字符引用原样写进属性，浏览器再解码：冒号、制表符都能这样藏起来
    命名字符引用藏冒号: '[点我](javascript&colon;alert(1))\n',
    数字字符引用藏冒号: '[点我](javascript&#58;alert(1))\n',
    字符引用藏制表符: '[点我](java&#x09;script:alert(1))\n',
    字符引用藏外站图片: '![图](https&#58;//img.example.invalid/x.png)\n',
  };
  for (const [name, body] of Object.entries(bad)) {
    assert.throws(
      () => parsePost(FRONT + body, 'a.md'),
      (err) => err.message === 'BAD_POST' && err.file === 'a.md',
      name,
    );
  }
});

test('plain links to other sites and relative images are allowed', () => {
  // 博客是自己的文字，可以链到别的网站；图片只能用和文章放在一起的
  const body =
    '看看 [GitHub 上的源码](https://github.com/Ethanyang9512)、<https://www.xiaoyuzhoufm.com/>，' +
    '站内的[作品](/works/)和[下一段](#more)。\n\n![示意图](figure.png)\n';

  const { html } = parsePost(FRONT + body, 'a.md');

  assert.match(html, /<a href="https:\/\/github\.com\/Ethanyang9512">GitHub 上的源码<\/a>/);
  assert.match(html, /<a href="https:\/\/www\.xiaoyuzhoufm\.com\/">/);
  assert.match(html, /<a href="\/works\/">作品<\/a>/);
  assert.match(html, /<img src="figure\.png" alt="示意图">/);
});
