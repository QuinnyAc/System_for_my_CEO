"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type {
  AccountMetric,
  AuthorizeUrl,
  ConnectionStatus,
  ImportResult,
  Platform,
  ProviderStatus,
  SocialAccount,
} from "@/lib/types";

export default function AccountsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [platformId, setPlatformId] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [externalId, setExternalId] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    const [p, a, m, c, ps] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
      api<ConnectionStatus[]>("/accounts/connections"),
      api<ProviderStatus>("/providers/status"),
    ]);
    setPlatforms(p);
    setAccounts(a);
    setMetrics(m);
    setConnections(c);
    setProviders(ps);
    if (!platformId && p[0]) setPlatformId(p[0].id);
  }

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const connection = query.get("connection");
    const result = query.get("status");
    if (connection && result) {
      setNotice(result === "connected" ? `${connection} 官方 API 已连接` : `${connection} 授权没有完成，请检查平台应用设置`);
      window.history.replaceState({}, "", "/accounts");
    }
    load().catch((e) => setError(e.message));
  }, []);

  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);
  const cmap = useMemo(() => new Map(connections.map((c) => [c.account_id, c])), [connections]);

  function oauthReady(slug: string | undefined): boolean {
    if (!providers || !slug) return false;
    if (slug === "youtube") return providers.youtube.oauth;
    if (slug === "instagram") return providers.instagram.oauth;
    if (slug === "facebook") return providers.facebook.oauth;
    if (slug === "pinterest") return providers.pinterest.oauth;
    return false;
  }

  function fallbackReady(slug: string | undefined): boolean {
    return slug === "youtube" && Boolean(providers?.youtube.api_key);
  }

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

  async function sync(a: SocialAccount) {
    setBusy(`sync-${a.id}`);
    setError("");
    setNotice("");
    try {
      await api<AccountMetric>(`/accounts/${a.id}/sync`, { method: "POST" });
      setNotice(`${a.name} 账号数据已同步`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "同步失败");
    } finally {
      setBusy("");
    }
  }

  async function connect(a: SocialAccount) {
    setBusy(`connect-${a.id}`);
    setError("");
    try {
      const result = await api<AuthorizeUrl>(`/accounts/${a.id}/authorize-url`);
      window.location.assign(result.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "授权连接失败");
      setBusy("");
    }
  }

  async function disconnect(a: SocialAccount) {
    if (!confirm(`确定断开“${a.name}”的官方 API 授权吗？已保存的数据不会删除。`)) return;
    setBusy(`disconnect-${a.id}`);
    try {
      await api<void>(`/accounts/${a.id}/connection`, { method: "DELETE" });
      setNotice(`${a.name} 已断开官方 API`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "断开失败");
    } finally {
      setBusy("");
    }
  }

  async function importRecent(a: SocialAccount) {
    setBusy(`import-${a.id}`);
    setError("");
    try {
      const result = await api<ImportResult>(`/accounts/${a.id}/import-content?limit=25`, { method: "POST" });
      setNotice(`${a.name} 导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy("");
    }
  }

  async function remove(a: SocialAccount) {
    if (!confirm(`确定删除账号“${a.name}”以及该账号下保存的内容和快照吗？`)) return;
    await api<void>(`/accounts/${a.id}`, { method: "DELETE" });
    await load();
  }

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Accounts</div>
          <h1>账号管理</h1>
          <p>每个平台可以添加多个账号，平台授权、数据快照和内容均按账号独立保存。</p>
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
          <div className="field"><label>平台内部 ID</label><input className="input" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="可留空，授权后自动识别；YouTube API Key 模式可填 Channel ID" /></div>
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
              const c = cmap.get(a.id);
              const ready = oauthReady(p?.slug);
              const fallback = fallbackReady(p?.slug);
              const isBusy = busy.endsWith(a.id);
              const state = c?.connected ? (c.status === "error" ? "API 异常" : "API 已连接") : fallback ? "公开 API Key 可用" : ready ? "等待授权" : "等待平台凭据";
              return (
                <div className="row" key={a.id} style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rowTitle">{a.name} <span className="pill">{p?.name}</span></div>
                    <div className="rowMeta">{a.handle || "无 handle"} · {m ? `${formatNumber(m.followers)} followers · ${formatNumber(m.views)} views` : "尚无数据快照"}</div>
                    <div className="rowMeta" style={{ marginTop: 6 }}>连接状态：<strong>{state}</strong>{c?.last_synced_at ? ` · 最近同步 ${new Date(c.last_synced_at).toLocaleString()}` : ""}</div>
                    {c?.last_error ? <div className="rowMeta" style={{ marginTop: 4 }}>最近错误：{c.last_error}</div> : null}
                    {c?.callback_url ? <div className="rowMeta" style={{ marginTop: 4, overflowWrap: "anywhere" }}>回调地址：{c.callback_url}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {ready ? <button className="button secondary" onClick={() => connect(a)} disabled={isBusy}>{c?.connected ? "重新授权" : "连接官方 API"}</button> : null}
                    <button className="button secondary" onClick={() => sync(a)} disabled={isBusy}>{busy === `sync-${a.id}` ? "同步中…" : "同步账号数据"}</button>
                    <button className="button secondary" onClick={() => importRecent(a)} disabled={isBusy}>{busy === `import-${a.id}` ? "导入中…" : "导入近期内容"}</button>
                    {c?.connected ? <button className="button secondary" onClick={() => disconnect(a)} disabled={isBusy}>断开 API</button> : null}
                    <button className="button danger" onClick={() => remove(a)} disabled={isBusy}>删除</button>
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
