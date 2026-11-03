// 网站生成器：把 data/*.json 和 content/blog/*.md 渲染成纯静态网站，再原样复制 assets/ 和每篇文章的
// content/blog/<slug>/（文章图片，复制到 blog/<slug>/）；隐藏文件不复制。
// 用法：node build.mjs [--out dist] [--preview] [--with-downloads] [--root <站点目录>]
//   --out             输出目录，必须不存在或是空的：只写不删，旧文件会让撤下的页面和下载包留在网站上。
//                     旧的输出先用 /usr/bin/trash 移走（npm run build 会先这样做）
//   --preview         站内目录链接补 index.html（私密预览用）
//   --with-downloads  从 GitHub 取各版本的源码包放进 downloads/，下载按钮指向本站。取不到的跳过：打印一行
//                     错误码（E_DOWNLOAD <文件名> [HTTP 状态] 或 E_NOT_ZIP <文件名>），那件作品页上不放下载按钮，
//                     构建照常完成
//   --root            data/、content/、assets/ 所在的目录，默认是本文件所在目录（测试用）
// 每页 <meta name="generator" content="site-build 版本">：版本取 GITHUB_SHA 前 7 位，没有就取
// git rev-parse --short HEAD，再没有写 dev（上线验收靠它认出是自己的构建）。
// 失败只打印错误码、退出 1，不打印原始报错：E_OUT_NOT_EMPTY、E_BAD_POST <文件名>、E_HELD <键> 应为<类型>、E_BUILD [系统错误码]。
// E_HELD：data/held.json 的格式不对（顶层不是对象，或四份清单里有不是字符串数组的），只说哪个键，不带值。
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadSite } from './lib/data.mjs';
import { heldErrorCode } from './lib/held.mjs';
import { renderPages } from './lib/render.mjs';
import { feedXml, llmsTxt, robotsTxt, sitemapXml } from './lib/seo.mjs';
import { fetchDownloads } from './scripts/fetch-downloads.mjs';

function buildVersion(rootDir) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return head || 'dev';
  } catch {
    return 'dev';
  }
}

const notHidden = (src) => !basename(src).startsWith('.');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// 输出目录不存在或为空才构建，否则抛 Error('OUT_NOT_EMPTY')，什么都不写
async function assertEmpty(outDir) {
  if (!(await exists(outDir))) return;
  if ((await readdir(outDir)).length > 0) throw new Error('OUT_NOT_EMPTY');
}

export async function buildSite({ rootDir, outDir, preview = false, withDownloads = false }) {
  await assertEmpty(outDir);
  const site = await loadSite(rootDir);
  // 取到了的源码包（文件名）；没加 --with-downloads 时是 null，下载按钮直接指向 GitHub
  const downloads = withDownloads ? new Set(await fetchDownloads(site.releases, outDir)) : null;

  const files = [
    ...renderPages(site, { preview, version: buildVersion(rootDir), downloads }),
    { path: 'llms.txt', content: llmsTxt(site) },
    { path: 'sitemap.xml', content: sitemapXml(site) },
    { path: 'robots.txt', content: robotsTxt(site) },
    ...(site.posts.length > 0 ? [{ path: 'blog/feed.xml', content: feedXml(site) }] : []),
  ];
  for (const { path, content } of files) {
    const file = join(outDir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await cp(join(rootDir, 'assets'), join(outDir, 'assets'), { recursive: true, filter: notHidden });
  // 只复制发布了的文章的图片（被撤下的文章不在 site.posts 里）。逐项复制进已有的 blog/<slug>/，
  // 和生成的页面重名就报错（ERR_FS_CP_EEXIST），不覆盖
  for (const { slug } of site.posts) {
    const dir = join(rootDir, 'content', 'blog', slug);
    if (!(await exists(dir))) continue;
    for (const name of (await readdir(dir)).filter((n) => !n.startsWith('.'))) {
      await cp(join(dir, name), join(outDir, 'blog', slug, name), {
        recursive: true,
        filter: notHidden,
        force: false,
        errorOnExist: true,
      });
    }
  }
  return { pages: files.map((f) => f.path).sort() };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'dist' },
      root: { type: 'string' },
      preview: { type: 'boolean', default: false },
      'with-downloads': { type: 'boolean', default: false },
    },
  });
  const { pages } = await buildSite({
    rootDir: values.root ? resolve(values.root) : dirname(fileURLToPath(import.meta.url)),
    outDir: resolve(values.out),
    preview: values.preview,
    withDownloads: values['with-downloads'],
  });
  console.log(`构建完成：${pages.length} 个页面`);
}

function errorCode(err) {
  if (err?.message === 'OUT_NOT_EMPTY') return 'E_OUT_NOT_EMPTY';
  if (err?.message === 'BAD_POST') return `E_BAD_POST ${err.file}`;
  if (err?.message === 'HELD') return heldErrorCode(err);
  return typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? `E_BUILD ${err.code}` : 'E_BUILD';
}

// 经软链接运行也要认得出是直接运行（不然命令行会什么都不做就退出 0）
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(errorCode(err));
    process.exitCode = 1;
  });
}
