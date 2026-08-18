"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, Platform, SocialAccount } from "@/lib/types";

type AccountMetricKey = "followers" | "content_count";

function metricKnown(metric: AccountMetric | undefined, key: AccountMetricKey) {
  if (!metric) return false;
  const extra = metric.extra_metrics || {};
  const known = extra.known;
  if (known && typeof known === "object" && typeof (known as Record<string, unknown>)[key] === "boolean") {
    return Boolean((known as Record<string, unknown>)[key]);
  }
  const available = extra.available;
  if (available && typeof available === "object" && typeof (available as Record<string, unknown>)[key] === "boolean") {
    return Boolean((available as Record<string, unknown>)[key]);
  }
  return metric[key] > 0;
}

function metricValue(metric: AccountMetric | undefined, key: AccountMetricKey) {
  return metricKnown(metric, key) && metric ? formatNumber(metric[key]) : "—";
}

export default function Dashboard() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const [p, a, m] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
    ]);
    setPlatforms(p);
    setAccounts(a);
    setMetrics(m);
    setError("");
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = window.setInterval(() => load().catch(() => null), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const metricMap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);
  const platformMap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const totals = accounts.reduce((acc, account) => {
    const metric = metricMap.get(account.id);
    if (metric) acc.synced += 1;
    if (metricKnown(metric, "followers") && metric) {
      acc.followers += metric.followers;
      acc.followersKnown += 1;
    }
    if (metricKnown(metric, "content_count") && metric) {
      acc.content += metric.content_count;
      acc.contentKnown += 1;
    }
    return acc;
  }, { followers: 0, content: 0, synced: 0, followersKnown: 0, contentKnown: 0 });

  return <>
    <header className="pageHeader"><div><div className="eyebrow">Social Media Operations</div><h1>运营总览</h1><p>集中查看各平台账号的公开粉丝/订阅数和视频/内容数量。</p></div></header>
    {error ? <div className="error">{error}</div> : null}
    <div className="grid">
      <div className="card"><div className="metricLabel">账号总数</div><div className="metricValue">{accounts.length}</div><div className="metricMeta">已添加账号</div></div>
      <div className="card"><div className="metricLabel">粉丝 / 订阅</div><div className="metricValue">{totals.followersKnown ? formatNumber(totals.followers) : "—"}</div><div className="metricMeta">已获得 {totals.followersKnown}/{accounts.length} 个账号数据</div></div>
      <div className="card"><div className="metricLabel">视频 / 内容总数</div><div className="metricValue">{totals.contentKnown ? formatNumber(totals.content) : "—"}</div><div className="metricMeta">已获得 {totals.contentKnown}/{accounts.length} 个账号数据</div></div>
      <div className="card"><div className="metricLabel">已同步账号</div><div className="metricValue">{totals.synced}</div><div className="metricMeta">已有账号快照</div></div>
    </div>
    <section className="section">
      <div className="sectionTitle"><h2>账号快照</h2><span>{accounts.length} accounts</span></div>
      {accounts.length === 0 ? <div className="empty">还没有账号。先到「账号管理」添加账号主页。</div> : (
        <div className="dataList">{accounts.map((account) => {
          const metric = metricMap.get(account.id);
          const platform = platformMap.get(account.platform_id);
          return <div className="row" key={account.id}>
            <div>
              <div className="rowTitle">{account.name}</div>
              <div className="rowMeta">{platform?.name || "Platform"}{account.handle ? ` · ${account.handle}` : ""}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="rowTitle">{metricValue(metric, "followers")} 粉丝/订阅 · {metricValue(metric, "content_count")} 视频/内容</div>
              <div className="rowMeta">{metric ? `最近同步 ${new Date(metric.captured_at).toLocaleString()}` : "等待首次同步"}</div>
            </div>
          </div>;
        })}</div>
      )}
    </section>
  </>;
}
