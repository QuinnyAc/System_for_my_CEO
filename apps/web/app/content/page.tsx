"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { ContentMetric, Platform, PublishedContent, SocialAccount } from "@/lib/types";

const metricKeys = ["views", "likes", "saves", "comments", "shares"] as const;
type MetricKey = typeof metricKeys[number];

function contentTypeLabel(type: string, platformSlug?: string) {
  if (platformSlug === "youtube") return type === "short" ? "YouTube 短视频" : "YouTube 长视频";
  if (platformSlug === "instagram") return type === "short" ? "Instagram Reel" : "Instagram Post";
  if (platformSlug === "facebook") return type === "short" ? "Facebook Reel" : type === "video" ? "Facebook Video" : "Facebook Post";
  if (platformSlug === "pinterest") return "Pinterest Pin";
  if (type === "short") return "Short / Reel";
  if (type === "post") return "Post";
  if (type === "pin") return "Pin";
  return "Video";
}

function metricKnown(metric: ContentMetric, key: MetricKey) {
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

function metricValue(metric: ContentMetric, key: MetricKey) {
  return metricKnown(metric, key) ? formatNumber(metric[key]) : "—";
}

function metricText(metric: ContentMetric) {
  return `${metricValue(metric, "views")} 播放/浏览 · ${metricValue(metric, "likes")} 点赞 · ${metricValue(metric, "saves")} 收藏 · ${metricValue(metric, "comments")} 评论 · ${metricValue(metric, "shares")} 分享`;
}

export default function ContentPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [items, setItems] = useState<PublishedContent[]>([]);
  const [metrics, setMetrics] = useState<ContentMetric[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const [p, a, c, m] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<PublishedContent[]>("/content"),
      api<ContentMetric[]>("/content/metrics/latest"),
    ]);
    setPlatforms(p);
    setAccounts(a);
    setItems(c);
    setMetrics(m);
    setError("");
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = window.setInterval(() => load().catch(() => null), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const amap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.content_id, m])), [metrics]);

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Published Content</div>
          <h1>内容数据</h1>
          <p>这里只显示已登记的作品及其公开可见数据。平台未公开或尚未成功读取的指标显示为 —，不会再用 0 代替未知值。</p>
        </div>
      </header>
      {error ? <div className="error">{error}</div> : null}

      <section className="section">
        <div className="sectionTitle"><h2>内容列表</h2><span>{items.length}</span></div>
        {items.length === 0 ? <div className="empty">目前还没有登记之后发现的新作品。新作品被发现后会自动出现在这里。</div> : (
          <div className="dataList">
            {items.map((item) => {
              const metric = mmap.get(item.id);
              const account = amap.get(item.account_id);
              const platform = account ? pmap.get(account.platform_id) : undefined;
              return (
                <div className="row" key={item.id} style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rowTitle">{item.title} <span className="pill">{contentTypeLabel(item.content_type, platform?.slug)}</span></div>
                    <div className="rowMeta">{account?.name || "未知账号"} · {platform?.name || "Platform"}</div>
                    {metric ? <div className="rowMeta" style={{ marginTop: 6 }}>{metricText(metric)}</div> : <div className="rowMeta" style={{ marginTop: 6 }}>等待首次数据快照</div>}
                    {metric ? <div className="rowMeta" style={{ marginTop: 4 }}>最近更新：{new Date(metric.captured_at).toLocaleString()}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {item.url ? <a className="button secondary" href={item.url} target="_blank" rel="noreferrer">打开作品</a> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
