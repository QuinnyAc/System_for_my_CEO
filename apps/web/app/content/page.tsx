"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { ContentMetric, Platform, PublishedContent, SocialAccount } from "@/lib/types";

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
  const [syncing, setSyncing] = useState("");

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

  async function sync(item: PublishedContent) {
    setSyncing(item.id);
    setError("");
    setNotice("");
    try {
      await api<ContentMetric>(`/content/${item.id}/sync`, { method: "POST" });
      setNotice(`${item.title} 数据已同步`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "内容同步失败");
    } finally {
      setSyncing("");
    }
  }

  async function remove(id: string) {
    if (!confirm("确定删除这条内容和所有历史数据吗？")) return;
    await api<void>(`/content/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <>
      <header className="pageHeader">
        <div><div className="eyebrow">Published Content</div><h1>内容数据</h1><p>管理四个平台的单条 Video、Short、Reel、Post 与 Pin，并写入连续数据快照。</p></div>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="card">
        <div className="sectionTitle"><h2>添加已发布内容</h2><span>Manual record</span></div>
        <form className="form" onSubmit={submit}>
          <div className="field"><label>账号</label><select className="select" required value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">选择账号</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div className="field"><label>内容类型</label><select className="select" value={type} onChange={(e) => setType(e.target.value)}><option value="video">Video</option><option value="short">Short / Reel</option><option value="post">Post</option><option value="pin">Pin</option></select></div>
          <div className="field full"><label>标题</label><input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label>作品链接</label><input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="YouTube 可只贴链接自动识别 Video ID" /></div>
          <div className="field"><label>平台内容 ID</label><input className="input" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="API 导入时会自动填写" /></div>
          <div><button className="button">保存内容</button></div>
        </form>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>内容列表</h2><span>{items.length}</span></div>
        {items.length === 0 ? <div className="empty">还没有发布内容记录。也可以从「账号管理」直接导入平台近期内容。</div> : (
          <div className="dataList">
            {items.map((item) => {
              const m = mmap.get(item.id);
              const account = amap.get(item.account_id);
              const platform = account ? pmap.get(account.platform_id) : undefined;
              return (
                <div className="row" key={item.id} style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rowTitle">{item.title} <span className="pill">{platform?.name || "Platform"}</span></div>
                    <div className="rowMeta">{account?.name} · {item.content_type}{item.external_id ? ` · ID ${item.external_id}` : ""}</div>
                    {m ? <div className="rowMeta" style={{ marginTop: 6 }}>{formatNumber(m.views)} views · {formatNumber(m.likes)} likes · {formatNumber(m.comments)} comments · {formatNumber(m.saves)} saves · {formatNumber(m.shares)} shares · {formatNumber(m.reach)} reach</div> : <div className="rowMeta" style={{ marginTop: 6 }}>未记录数据</div>}
                    {m ? <div className="rowMeta" style={{ marginTop: 4 }}>最近快照：{new Date(m.captured_at).toLocaleString()}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button className="button secondary" onClick={() => sync(item)} disabled={syncing === item.id}>{syncing === item.id ? "同步中…" : "立即同步"}</button>
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
