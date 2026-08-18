"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, ContentMetric, PublishedContent, SocialAccount } from "@/lib/types";

type ContentKey = "views" | "likes" | "saves" | "shares";

function known(extra: Record<string, unknown>, key: string, value: number) {
  const knownMap = extra.known;
  if (knownMap && typeof knownMap === "object" && typeof (knownMap as Record<string, unknown>)[key] === "boolean") {
    return Boolean((knownMap as Record<string, unknown>)[key]);
  }
  const available = extra.available;
  if (available && typeof available === "object" && typeof (available as Record<string, unknown>)[key] === "boolean") {
    return Boolean((available as Record<string, unknown>)[key]);
  }
  return value > 0;
}

function contentKnown(metric: ContentMetric, key: ContentKey) {
  return known(metric.extra_metrics || {}, key, metric[key]);
}

function contentValue(metric: ContentMetric, key: ContentKey) {
  return contentKnown(metric, key) ? formatNumber(metric[key]) : "—";
}

function followerKnown(metric: AccountMetric) {
  return known(metric.extra_metrics || {}, "followers", metric.followers);
}

export default function AnalyticsPage() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [accountMetrics, setAccountMetrics] = useState<AccountMetric[]>([]);
  const [content, setContent] = useState<PublishedContent[]>([]);
  const [contentMetrics, setContentMetrics] = useState<ContentMetric[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const [a, am, c, cm] = await Promise.all([
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
      api<PublishedContent[]>("/content"),
      api<ContentMetric[]>("/content/metrics/latest"),
    ]);
    setAccounts(a);
    setAccountMetrics(am);
    setContent(c);
    setContentMetrics(cm);
    setError("");
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = window.setInterval(() => load().catch(() => null), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const contentMap = useMemo(() => new Map(content.map((c) => [c.id, c])), [content]);
  const ranked = useMemo(
    () => contentMetrics.filter((m) => contentKnown(m, "views")).sort((a, b) => b.views - a.views).slice(0, 10),
    [contentMetrics]
  );
  const knownFollowers = accountMetrics.filter(followerKnown);
  const knownViews = contentMetrics.filter((metric) => contentKnown(metric, "views"));
  const followerTotal = knownFollowers.reduce((sum, metric) => sum + metric.followers, 0);
  const viewTotal = knownViews.reduce((sum, metric) => sum + metric.views, 0);

  return <>
    <header className="pageHeader"><div><div className="eyebrow">Analytics</div><h1>数据分析</h1><p>基于每个账号和作品的最新公开快照汇总。未成功读取的指标不会按 0 参与排名或合计。</p></div></header>
    {error ? <div className="error">{error}</div> : null}
    <div className="grid">
      <div className="card"><div className="metricLabel">账号快照</div><div className="metricValue">{accountMetrics.length}</div><div className="metricMeta">{accounts.length} 个账号</div></div>
      <div className="card"><div className="metricLabel">内容快照</div><div className="metricValue">{contentMetrics.length}</div><div className="metricMeta">{content.length} 条内容</div></div>
      <div className="card"><div className="metricLabel">总粉丝 / 订阅</div><div className="metricValue">{knownFollowers.length ? formatNumber(followerTotal) : "—"}</div><div className="metricMeta">已获得 {knownFollowers.length}/{accounts.length} 个账号</div></div>
      <div className="card"><div className="metricLabel">内容播放 / 浏览</div><div className="metricValue">{knownViews.length ? formatNumber(viewTotal) : "—"}</div><div className="metricMeta">已获得 {knownViews.length}/{content.length} 条内容</div></div>
    </div>
    <section className="section">
      <div className="sectionTitle"><h2>当前表现最高内容</h2><span>按已读取播放/浏览量</span></div>
      {ranked.length === 0 ? <div className="empty">暂无可用于播放量排名的内容数据</div> : (
        <div className="dataList">{ranked.map((metric) => {
          const item = contentMap.get(metric.content_id);
          const account = item ? accountMap.get(item.account_id) : undefined;
          return <div className="row" key={metric.id}>
            <div>
              <div className="rowTitle">{item?.title || "Unknown content"}</div>
              <div className="rowMeta">{account?.name || "未知账号"}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="rowTitle">{contentValue(metric, "views")} 播放/浏览</div>
              <div className="rowMeta">{contentValue(metric, "likes")} 点赞 · {contentValue(metric, "saves")} 收藏 · {contentValue(metric, "shares")} 分享</div>
            </div>
          </div>;
        })}</div>
      )}
    </section>
  </>;
}
