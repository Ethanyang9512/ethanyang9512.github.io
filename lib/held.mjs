// held.json 的格式规则：构建（lib/data.mjs）和每天的同步（scripts/sync-podcast.mjs）共用这一份。
// 单独放一个文件、不引任何外部依赖：同步脚本引它，没装 node_modules 时也能直接跑（lib/data.mjs 会牵出 marked）。
// 顶层必须是普通对象；episodes、releases、posts、deleted 四个键缺了当空的（旧文件没有 deleted），在的话必须是字符串数组
// （写成字符串会被逐字遍历、null 会被当成没有，本该藏起来的项就照样上站）。不认识的键忽略。
// 格式不对抛 HELD，只带哪个键、该是什么类型，不带值；heldErrorCode 把它打印成 E_HELD <键> 应为<类型>。
const HELD_KEYS = ['episodes', 'releases', 'posts', 'deleted'];
const heldError = (key, expected) => Object.assign(new Error('HELD'), { key, expected });
export const heldErrorCode = ({ key, expected }) => `E_HELD ${key} 应为${expected}`;

// held.json 解析出来的内容 → { episodes, releases, posts, deleted }（四份清单，缺的是空数组）；格式不对抛 HELD
export function heldLists(held) {
  if (held === null || typeof held !== 'object' || Array.isArray(held)) throw heldError('held.json', '对象');
  const lists = {};
  for (const key of HELD_KEYS) {
    const list = Object.hasOwn(held, key) ? held[key] : [];
    if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) throw heldError(key, '字符串数组');
    lists[key] = list;
  }
  return lists;
}
