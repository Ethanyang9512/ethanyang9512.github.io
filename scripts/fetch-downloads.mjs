// 构建时取源码包：把每个版本 GitHub 自动打好的源码压缩包原样存到 <outDir>/downloads/<zipName>，返回存好了的文件名。
// 取不到的跳过，构建照常完成，页面上那件作品就不放下载按钮。跳过时打印一行错误码，不打印原始报错：
// E_DOWNLOAD <文件名> [HTTP 状态]（网络错或 HTTP 非 2xx）、E_NOT_ZIP <文件名>（拿到的不是 zip）。
// 网络受限时可设置 NODE_USE_ENV_PROXY=1，让 Node 自带的 fetch 按环境变量里的代理连接。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// 取一个包：拿到了返回 { body }，拿不到返回 { code: 错误码 }
async function fetchZip(fetch, zipUrl, zipName) {
  let res;
  let body;
  try {
    res = await fetch(zipUrl, { signal: AbortSignal.timeout(120_000) });
    if (res.ok) body = Buffer.from(await res.arrayBuffer());
  } catch {
    return { code: `E_DOWNLOAD ${zipName}` };
  }
  if (!res.ok) return { code: `E_DOWNLOAD ${zipName} ${res.status}` };
  if (!body.subarray(0, 4).equals(ZIP_MAGIC)) return { code: `E_NOT_ZIP ${zipName}` };
  return { body };
}

export async function fetchDownloads(releases, outDir, { fetch = globalThis.fetch, log = console.error } = {}) {
  const dir = join(outDir, 'downloads');
  const saved = [];
  for (const { zipUrl, zipName } of Object.values(releases)) {
    const { code, body } = await fetchZip(fetch, zipUrl, zipName);
    if (code) {
      log(code);
      continue;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, zipName), body);
    saved.push(zipName);
  }
  return saved;
}
