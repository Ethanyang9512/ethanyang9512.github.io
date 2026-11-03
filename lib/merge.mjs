// 单集只增不删：按 eid 合并，已有的用新值更新标题、日期、时长；结果按发布时间倒序。
// added 是新增的 eid，顺序同结果（新的在前）。

const pick = ({ eid, title, pubDate, duration, url }) => ({ eid, title, pubDate, duration, url });

export function mergeEpisodes(existing, incoming) {
  const byId = new Map(existing.map((e) => [e.eid, pick(e)]));
  const before = new Set(byId.keys());
  for (const e of incoming) byId.set(e.eid, pick(e));

  const episodes = [...byId.values()].sort(
    (a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate) || (a.eid < b.eid ? -1 : 1),
  );
  const added = episodes.filter((e) => !before.has(e.eid)).map((e) => e.eid);
  return { episodes, added };
}

// 页面这一批里缺掉的单集：节目页只给最新的一批（约 15 期）。已知的某期发布时间不早于这一批里最旧的那期，
// 页面上却没有它，就是缺掉了；比这一批更早的本来就不在页面上，判断不了，只能靠期数核对。
// 缺掉不一定是删了（页面可能一时不完整）：同步只在来源的总期数比上次少时才认（scripts/sync-podcast.mjs）。
// known 是已知的单集，page 是页面上的这一批（不能是空的）。返回缺掉的 eid，顺序同 known。
export function removedEpisodes(known, page) {
  const onPage = new Set(page.map((e) => e.eid));
  const oldest = Math.min(...page.map((e) => Date.parse(e.pubDate)));
  return known.filter((e) => !onPage.has(e.eid) && Date.parse(e.pubDate) >= oldest).map((e) => e.eid);
}
