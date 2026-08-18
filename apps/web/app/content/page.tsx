"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
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
  const [accountId, setAccountId] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [externalId, setExternalId] = useState("");
  const [type, setType] = useState("video");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
    if (!accountId && a[0]) setAccountId(a[0].id);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const amap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.content_id, m])), [metrics]);
  const selectedAccount = amap.get(accountId);
  const selectedPlatform = selectedAccount ? pmap.get(selectedAccount.platform_id) : undefined;
  const isYouTube = selectedPlatform?.slug === "youtube";

  useEffect(() => {
    if (isYouTube && type !== "video" && type !== "short") setType("video");
  }, [isYouTube, type]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    await api<PublishedContent>("/content", {
      method: "POST",
      body: JSON.stringify({
        account_id: accountId,
        title,
        content_type: type,
        external_id: externalId || null,
        url: url || null,
        published_at: new Date().toISOString(),
      }),
    });
    setTitle(""); setUrl(""); setExternalId("");
    setNotice("内容记录已保存");
    await load();
  }

  async function remove(id: string) {
    if (!confirm("确定删除这条内容和所有历史数据吗？")) return;
    await api<void>(`/content/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <>
      <header className="pageHeader">
        <div><div className="eyebrow">Published Content</div><h1>内容数据</h1><p>查看公开采集到的单条内容数据；YouTube 长视频和短视频分开显示。</p></div>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="card">
        <div className="sectionTitle"><h2>手动添加已发布内容</h2><span>Optional</span></div>
        <form className="form" onSubmit={submit}>
          <div className="field"><label>账号</label><select className="select" required value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">选择账号</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="field"><label>内容类型</label><select className="select" value={type} onChange={(e) => setType(e.target.value)}>{isYouTube ? <><option value="video">YouTube 长视频</option><option value="short">YouTube 短视频</option></> : <><option value="video">Video</option><option value="short">Short / Reel</option><option value="post">Post</option><option value="pin">Pin</option></>}</select></div>
          <div className="field full"><label>标题</label><input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label>作品链接</label><input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." /></div>
          <div className="field"><label>平台内容 ID</label><input className="input" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="可留空" /></div>
          <div><button className="button">保存内容</button></div>
        </form>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>内容列表</h2><span>{items.length}</span></div>
        {items.length === 0 ? <div className="empty">还没有内容记录。把作品链接加入「公开数据采集」队列后，电脑会自动读取并创建记录。</div> : (
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
                    {m ? <div className="rowMeta" style={{ marginTop: 6 }}>{formatNumber(m.views)} 播放 · {formatNumber(m.likes)} 赞 · {formatNumber(m.comments)} 评论 · {formatNumber(m.saves)} 收藏 · {formatNumber(m.shares)} 分享</div> : <div className="rowMeta" style={{ marginTop: 6 }}>未记录数据</div>}
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
