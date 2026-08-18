"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { ContentMetric, Platform, PublishedContent, SocialAccount } from "@/lib/types";

function contentTypeLabel(type: string, platformSlug?: string) {
  if (platformSlug === "youtube") return type === "short" ? "YouTube 短视频" : "YouTube 长视频";
  if (type === "short") return "Short / Reel";
  if (type === "post") return "Post";
  if (type === "pin") return "Pin";
  return "Video";
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
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const amap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.content_id, m])), [metrics]);

  async function remove(id: string) {
    if (!confirm("确定删除这条内容和所有历史数据吗？")) return;
    await api<void>(`/content/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Published Content</div>
          <h1>内容数据</h1>
          <p>这里只显示通过「公开数据采集」链接队列自动读取到的作品和公开数据。YouTube 长视频与短视频分开显示。</p>
        </div>
      </header>
      {error ? <div className="error">{error}</div> : null}

      <section className="section">
        <div className="sectionTitle"><h2>内容列表</h2><span>{items.length}</span></div>
        {items.length === 0 ? <div className="empty">还没有内容记录。把作品链接加入「公开数据采集」队列后，电脑读取成功会自动创建记录。</div> : (
          <div className="dataList">
            {items.map((item) => {
              const m = mmap.get(item.id);
              const account = amap.get(item.account_id);
              const platform = account ? pmap.get(account.platform_id) : undefined;
              return (
                <div className="row" key={item.id} style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rowTitle">{item.title} <span className="pill">{contentTypeLabel(item.content_type, platform?.slug)}</span></div>
                    <div className="rowMeta">{account?.name} · {platform?.name || "Platform"}{item.external_id ? ` · ID ${item.external_id}` : ""}</div>
                    {m ? <div className="rowMeta" style={{ marginTop: 6 }}>{formatNumber(m.views)} 播放 · {formatNumber(m.likes)} 赞 · {formatNumber(m.comments)} 评论 · {formatNumber(m.saves)} 收藏 · {formatNumber(m.shares)} 分享</div> : <div className="rowMeta" style={{ marginTop: 6 }}>未记录数据（旧手动记录可删除后重新加入采集队列）</div>}
                    {m ? <div className="rowMeta" style={{ marginTop: 4 }}>最近快照：{new Date(m.captured_at).toLocaleString()}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {item.url ? <a className="button secondary" href={item.url} target="_blank" rel="noreferrer">打开作品</a> : null}
                    <button className="button danger" onClick={() => remove(item.id)}>删除</button>
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
