"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, Platform, SocialAccount } from "@/lib/types";

export default function Dashboard() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest")
    ]).then(([p,a,m]) => { setPlatforms(p); setAccounts(a); setMetrics(m); }).catch((e) => setError(e.message));
  }, []);

  const metricMap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);
  const totals = accounts.reduce((acc, account) => {
    const m = metricMap.get(account.id);
    acc.followers += m?.followers || 0; acc.views += m?.views || 0; acc.reach += m?.reach || 0; acc.content += m?.content_count || 0;
    return acc;
  }, { followers: 0, views: 0, reach: 0, content: 0 });

  const platformMap = new Map(platforms.map((p) => [p.id, p]));
  return <>
    <header className="pageHeader"><div><div className="eyebrow">ZenoMinerals · Social Operations</div><h1>运营总览</h1><p>集中查看 YouTube、Instagram、Facebook、Pinterest 的账号规模和内容表现。</p></div></header>
    {error ? <div className="error">{error}</div> : null}
    <div className="grid">
      <div className="card"><div className="metricLabel">账号总数</div><div className="metricValue">{accounts.length}</div><div className="metricMeta">4 个目标平台</div></div>
      <div className="card"><div className="metricLabel">粉丝 / 订阅</div><div className="metricValue">{formatNumber(totals.followers)}</div><div className="metricMeta">最新账号快照合计</div></div>
      <div className="card"><div className="metricLabel">累计播放 / 浏览</div><div className="metricValue">{formatNumber(totals.views)}</div><div className="metricMeta">按平台可获得指标汇总</div></div>
      <div className="card"><div className="metricLabel">内容数量</div><div className="metricValue">{formatNumber(totals.content)}</div><div className="metricMeta">账号最新快照</div></div>
    </div>
    <section className="section"><div className="sectionTitle"><h2>账号快照</h2><span>{accounts.length} accounts</span></div>
      {accounts.length === 0 ? <div className="empty">还没有账号。先到「账号管理」添加 YouTube、Instagram、Facebook 或 Pinterest。</div> : <div className="dataList">{accounts.map((a) => { const m=metricMap.get(a.id); return <div className="row" key={a.id}><div><div className="rowTitle">{a.name}</div><div className="rowMeta">{platformMap.get(a.platform_id)?.name || "Platform"}{a.handle ? ` · ${a.handle}` : ""}</div></div><div style={{textAlign:"right"}}><div className="rowTitle">{formatNumber(m?.followers || 0)} followers</div><div className="rowMeta">{formatNumber(m?.views || 0)} views · {m ? new Date(m.captured_at).toLocaleString() : "未同步"}</div></div></div>})}</div>}
    </section>
  </>;
}
