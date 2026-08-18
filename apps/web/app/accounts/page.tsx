"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, Platform, SocialAccount } from "@/lib/types";

export default function AccountsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [platformId, setPlatformId] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [externalId, setExternalId] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [p, a, m] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
    ]);
    setPlatforms(p);
    setAccounts(a);
    setMetrics(m);
    if (!platformId && p[0]) setPlatformId(p[0].id);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    await api<SocialAccount>("/accounts", {
      method: "POST",
      body: JSON.stringify({
        platform_id: platformId,
        name,
        handle: handle || null,
        external_id: externalId || null,
        profile_url: profileUrl || null,
      }),
    })
      .then(() => {
        setName("");
        setHandle("");
        setExternalId("");
        setProfileUrl("");
        setNotice("账号已添加");
        return load();
      })
      .catch((e) => setError(e.message));
  }

  async function remove(a: SocialAccount) {
    if (!confirm(`确定删除账号“${a.name}”以及该账号下保存的内容和数据吗？`)) return;
    await api<void>(`/accounts/${a.id}`, { method: "DELETE" });
    await load();
  }

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Accounts</div>
          <h1>账号管理</h1>
          <p>用于整理不同平台账号。公开数据由浏览器采集助手自动写入，不需要平台 API 授权。</p>
        </div>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="card">
        <div className="sectionTitle"><h2>添加账号</h2><span>Account record</span></div>
        <form className="form" onSubmit={submit}>
          <div className="field"><label>平台</label><select className="select" value={platformId} onChange={(e) => setPlatformId(e.target.value)}>{platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div className="field"><label>账号名称</label><input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Main Account" /></div>
          <div className="field"><label>Handle / 用户名</label><input className="input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" /></div>
          <div className="field"><label>平台内部 ID</label><input className="input" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="可留空" /></div>
          <div className="field full"><label>主页链接</label><input className="input" type="url" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://..." /></div>
          <div><button className="button" type="submit">保存账号</button></div>
        </form>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>已保存账号</h2><span>{accounts.length}</span></div>
        {accounts.length === 0 ? <div className="empty">暂无账号</div> : (
          <div className="dataList">
            {accounts.map((a) => {
              const m = mmap.get(a.id);
              const p = pmap.get(a.platform_id);
              return (
                <div className="row" key={a.id} style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rowTitle">{a.name} <span className="pill">{p?.name || "Platform"}</span></div>
                    <div className="rowMeta">{a.handle || "无 handle"} · {m ? `${formatNumber(m.followers)} 粉丝/订阅 · ${formatNumber(m.views)} 公开浏览` : "尚无数据快照"}</div>
                    {a.profile_url ? <div className="rowMeta" style={{ marginTop: 4, overflowWrap: "anywhere" }}>{a.profile_url}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {a.profile_url ? <a className="button secondary" href={a.profile_url} target="_blank" rel="noreferrer">打开主页</a> : null}
                    <button className="button danger" onClick={() => remove(a)}>删除</button>
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
