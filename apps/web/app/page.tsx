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
    acc.followers += m?.followers || 0;
    acc.content += m?.content_count || 0;
    if (m) acc.synced += 1;
    return acc;
  }, { followers: 0, content: 0, synced: 0 });

  const platformMap = new Map(platforms.map((p) => [p.id, p]));
  return <>
    <header className="pageHeader"><div><div className="eyebrow">Social Media Operations</div><h1>运营总览</h1><p>集中查看各平台账号规模。添加账号主页后，后台会自动同步账号快照和新增作品数据。</p></div></header>
    {error ? <div className="error">{error}</div> : null}
    <div className="grid">
      <div className="card"><div className="metricLabel">账号总数</div><div className="metricValue">{accounts.length}</div><div className="metricMeta">已添加账号</div></div>
      <div className="card"><div className="metricLabel">粉丝 / 订阅</div><div className="metricValue">{formatNumber(totals.followers)}</div><div className="metricMeta">最新账号快照合计</div></div>
      <div className="card"><div className="metricLabel">视频 / 内容总数</div><div className="metricValue">{formatNumber(totals.content)}</div><div className="metricMeta">各账号最新公开数量</div></div>
      <div className="card"><div className="metricLabel">已同步账号</div><div className="metricValue">{totals.synced}</div><div className="metricMeta">已有账号快照</div></div>
    </div>
    <section className="section"><div className="sectionTitle"><h2>账号快照</h2><span>{accounts.length} accounts</span></div>
      {accounts.length === 0 ? <div className="empty">还没有账号。先到「账号管理」添加账号主页。</div> : <div className="dataList">{accounts.map((a) => { const m=metricMap.get(a.id); return <div className="row" key={a.id}><div><div className="rowTitle">{a.name}</div><div className="rowMeta">{platformMap.get(a.platform_id)?.name || "Platform"}{a.handle ? ` · ${a.handle}` : ""}</div></div><div style={{textAlign:"right"}}><div className="rowTitle">{formatNumber(m?.followers || 0)} 粉丝/订阅 · {formatNumber(m?.content_count || 0)} 视频/内容</div><div className="rowMeta">{m ? `最近同步 ${new Date(m.captured_at).toLocaleString()}` : "等待首次同步"}</div></div></div>})}</div>}
    </section>
  </>;
}
