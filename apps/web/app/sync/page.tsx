"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { ConnectionStatus, Platform, SocialAccount, SyncAllResult, SyncLog } from "@/lib/types";

export default function SyncPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const [p, a, c, l] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<ConnectionStatus[]>("/accounts/connections"),
      api<SyncLog[]>("/sync-logs?limit=50"),
    ]);
    setPlatforms(p); setAccounts(a); setConnections(c); setLogs(l);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const amap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const cmap = useMemo(() => new Map(connections.map((c) => [c.account_id, c])), [connections]);

  async function syncAll() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<SyncAllResult>("/sync-all", { method: "POST" });
      setNotice(`全部同步完成：账号成功 ${result.accounts_ok} / 失败 ${result.accounts_error}，内容成功 ${result.content_ok} / 失败 ${result.content_error}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "全部同步失败");
    } finally { setBusy(false); }
  }

  const connected = connections.filter((c) => c.connected).length;
  const errors = connections.filter((c) => c.status === "error").length;

  return (
    <>
      <header className="pageHeader">
        <div><div className="eyebrow">Synchronization</div><h1>同步中心</h1><p>统一查看 YouTube、Instagram、Facebook、Pinterest 的授权状态和最近同步结果。</p></div>
        <button className="button" onClick={syncAll} disabled={busy}>{busy ? "同步中…" : "同步全部账号与内容"}</button>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className="grid">
        <div className="card"><div className="metricLabel">账号数量</div><div className="metricValue">{accounts.length}</div><div className="metricMeta">四个平台独立账号</div></div>
        <div className="card"><div className="metricLabel">API 已连接</div><div className="metricValue">{connected}</div><div className="metricMeta">完成 OAuth 的账号</div></div>
        <div className="card"><div className="metricLabel">连接异常</div><div className="metricValue">{errors}</div><div className="metricMeta">需要重新授权或检查权限</div></div>
        <div className="card"><div className="metricLabel">同步日志</div><div className="metricValue">{logs.length}</div><div className="metricMeta">显示最近 50 条</div></div>
      </div>

      <section className="section">
        <div className="sectionTitle"><h2>账号连接状态</h2><span>{accounts.length}</span></div>
        {accounts.length === 0 ? <div className="empty">还没有账号。</div> : <div className="dataList">{accounts.map((account) => {
          const p = pmap.get(account.platform_id);
          const c = cmap.get(account.id);
          const state = c?.connected ? (c.status === "error" ? "异常" : "已连接") : c?.configured ? "等待授权" : "等待凭据";
          return <div className="row" key={account.id}><div><div className="rowTitle">{account.name} <span className="pill">{p?.name}</span></div><div className="rowMeta">{account.handle || "无 handle"} · API {state}</div></div><div style={{ textAlign: "right" }}><div className="rowTitle">{c?.last_synced_at ? new Date(c.last_synced_at).toLocaleString() : "尚未同步"}</div><div className="rowMeta">{c?.last_error || "无最近错误"}</div></div></div>;
        })}</div>}
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>最近同步日志</h2><span>{logs.length}</span></div>
        {logs.length === 0 ? <div className="empty">暂无同步日志。</div> : <div className="dataList">{logs.map((log) => {
          const account = log.target_type === "account" ? amap.get(log.target_id) : undefined;
          return <div className="row" key={log.id}><div><div className="rowTitle">{log.status === "success" ? "成功" : "失败"} · {log.provider} · {log.target_type}</div><div className="rowMeta">{account?.name || log.target_id}{log.message ? ` · ${log.message}` : ""}</div></div><div className="rowMeta">{new Date(log.created_at).toLocaleString()}</div></div>;
        })}</div>}
      </section>
    </>
  );
}
