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
  const visibleContent = useMemo(() => content.filter((item) => {
    const account = accountMap.get(item.account_id);
    if (!account?.baseline_at) return false;
    const baseline = new Date(account.baseline_at).getTime();
    const registered = new Date(item.created_at).getTime();
    return Number.isFinite(baseline) && Number.isFinite(registered) && registered >= baseline;
  }), [content, accountMap]);
  const visibleContentMap = useMemo(() => new Map(visibleContent.map((item) => [item.id, item])), [visibleContent]);
  const visibleContentIds = useMemo(() => new Set(visibleContent.map((item) => item.id)), [visibleContent]);
  const visibleMetrics = useMemo(
    () => contentMetrics.filter((metric) => visibleContentIds.has(metric.content_id)),
    [contentMetrics, visibleContentIds]
  );
  const ranked = useMemo(
    () => visibleMetrics.filter((m) => contentKnown(m, "views")).sort((a, b) => b.views - a.views).slice(0, 10),
    [visibleMetrics]
  );
  const knownFollowers = accountMetrics.filter(followerKnown);
  const knownViews = visibleMetrics.filter((metric) => contentKnown(metric, "views"));
  const followerTotal = knownFollowers.reduce((sum, metric) => sum + metric.followers, 0);
  const viewTotal = knownViews.reduce((sum, metric) => sum + metric.views, 0);

  return <>
    <header className="pageHeader"><div><div className="eyebrow">Analytics</div><h1>数据分析</h1><p>只统计账号建立基线之后发现的新作品及其最新公开快照。历史作品不会进入排名或播放量合计；未成功读取的指标不会按 0 计算。</p></div></header>
    {error ? <div className="error">{error}</div> : null}
    <div className="grid">
      <div className="card"><div className="metricLabel">账号快照</div><div className="metricValue">{accountMetrics.length}</div><div className="metricMeta">{accounts.length} 个账号</div></div>
      <div className="card"><div className="metricLabel">登记后内容快照</div><div className="metricValue">{visibleMetrics.length}</div><div className="metricMeta">{visibleContent.length} 条登记后新内容</div></div>
      <div className="card"><div className="metricLabel">总粉丝 / 订阅</div><div className="metricValue">{knownFollowers.length ? formatNumber(followerTotal) : "—"}</div><div className="metricMeta">已获得 {knownFollowers.length}/{accounts.length} 个账号</div></div>
      <div className="card"><div className="metricLabel">新内容播放 / 浏览</div><div className="metricValue">{knownViews.length ? formatNumber(viewTotal) : "—"}</div><div className="metricMeta">已获得 {knownViews.length}/{visibleContent.length} 条新内容</div></div>
    </div>
    <section className="section">
      <div className="sectionTitle"><h2>登记后表现最高内容</h2><span>按已读取播放/浏览量</span></div>
      {ranked.length === 0 ? <div className="empty">暂无登记后新作品可用于播放量排名</div> : (
        <div className="dataList">{ranked.map((metric) => {
          const item = visibleContentMap.get(metric.content_id);
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
