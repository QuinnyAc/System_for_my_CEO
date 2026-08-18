"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { AccountMetric, ContentMetric, PublishedContent, SocialAccount } from "@/lib/types";

function sourceOf(extra: Record<string, unknown>) {
  return String(extra?.source || "");
}

function machineOf(extra: Record<string, unknown>) {
  return String(extra?.machine_name || "").trim();
}

export default function CollectorPage() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [contents, setContents] = useState<PublishedContent[]>([]);
  const [accountMetrics, setAccountMetrics] = useState<AccountMetric[]>([]);
  const [contentMetrics, setContentMetrics] = useState<ContentMetric[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const [a, c, am, cm] = await Promise.all([
      api<SocialAccount[]>("/accounts"),
      api<PublishedContent[]>("/content"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
      api<ContentMetric[]>("/content/metrics/latest"),
    ]);
    setAccounts(a);
    setContents(c);
    setAccountMetrics(am);
    setContentMetrics(cm);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = setInterval(() => load().catch(() => null), 30_000);
    return () => clearInterval(timer);
  }, []);

  const publicAccountMetrics = useMemo(
    () => accountMetrics.filter((m) => sourceOf(m.extra_metrics) === "browser_public_view"),
    [accountMetrics]
  );
  const publicContentMetrics = useMemo(
    () => contentMetrics.filter((m) => sourceOf(m.extra_metrics) === "browser_public_view"),
    [contentMetrics]
  );

  const machineNames = useMemo(() => {
    const values = [...publicAccountMetrics, ...publicContentMetrics]
      .map((m) => machineOf(m.extra_metrics))
      .filter(Boolean);
    return [...new Set(values)].sort();
  }, [publicAccountMetrics, publicContentMetrics]);

  const lastSeen = useMemo(() => {
    const values = [...publicAccountMetrics, ...publicContentMetrics]
      .map((m) => new Date(m.captured_at).getTime())
      .filter(Number.isFinite);
    return values.length ? new Date(Math.max(...values)) : null;
  }, [publicAccountMetrics, publicContentMetrics]);

  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const contentMap = useMemo(() => new Map(contents.map((c) => [c.id, c])), [contents]);

  const recent = useMemo(() => {
    const rows = [
      ...publicAccountMetrics.map((m) => ({
        id: `a-${m.id}`,
        time: m.captured_at,
        machine: machineOf(m.extra_metrics),
        title: accountMap.get(m.account_id)?.name || "账号",
        detail: `${m.followers.toLocaleString()} 粉丝/订阅 · ${m.views.toLocaleString()} 公开浏览`,
      })),
      ...publicContentMetrics.map((m) => ({
        id: `c-${m.id}`,
        time: m.captured_at,
        machine: machineOf(m.extra_metrics),
        title: contentMap.get(m.content_id)?.title || "内容",
        detail: `${m.views.toLocaleString()} 播放 · ${m.likes.toLocaleString()} 赞 · ${m.comments.toLocaleString()} 评论`,
      })),
    ];
    return rows.sort((x, y) => new Date(y.time).getTime() - new Date(x.time).getTime()).slice(0, 20);
  }, [publicAccountMetrics, publicContentMetrics, accountMap, contentMap]);

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Public View Collector</div>
          <h1>公开数据采集</h1>
          <p>默认模式。员工正常打开 YouTube、Instagram、Facebook 或 Pinterest 页面，浏览器助手只读取页面已经公开显示的数字并回传。</p>
        </div>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <div className="grid">
        <div className="card"><div className="metricLabel">已回传电脑</div><div className="metricValue">{machineNames.length}</div><div className="metricMeta">按电脑名称去重</div></div>
        <div className="card"><div className="metricLabel">公开账号快照</div><div className="metricValue">{publicAccountMetrics.length}</div><div className="metricMeta">当前最新值</div></div>
        <div className="card"><div className="metricLabel">公开内容快照</div><div className="metricValue">{publicContentMetrics.length}</div><div className="metricMeta">当前最新值</div></div>
        <div className="card"><div className="metricLabel">最近回传</div><div className="metricValue" style={{ fontSize: 18 }}>{lastSeen ? lastSeen.toLocaleTimeString() : "—"}</div><div className="metricMeta">{lastSeen ? lastSeen.toLocaleDateString() : "尚无浏览器数据"}</div></div>
      </div>

      <section className="section card">
        <div className="sectionTitle"><h2>使用方式</h2><span>Simple mode</span></div>
        <div className="rowMeta" style={{ lineHeight: 1.9 }}>
          1. 每台电脑安装一次 <code>browser-collector</code> Chrome 扩展。<br/>
          2. 中央 Codespace 运行 <code>bash .devcontainer/show-collector-config.sh</code>，把 Collector URL 和 Token 填进扩展。<br/>
          3. 给电脑起唯一名称，例如 Computer-01、Computer-02。<br/>
          4. 以后只需正常打开平台主页或内容页面，扩展会在页面稳定后自动读取可见数字。<br/>
          5. 读不到的字段直接跳过，不猜测、不制造数据。
        </div>
        <div className="notice" style={{ marginTop: 12 }}>Google / Meta / Pinterest API 授权现在属于可选高级功能。普通运营不需要逐账号授权。</div>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>已回传电脑</h2><span>{machineNames.length}</span></div>
        {machineNames.length === 0 ? <div className="empty">尚未安装并连接浏览器采集助手。</div> : <div className="dataList">{machineNames.map((name) => <div className="row" key={name}><div><div className="rowTitle">{name}</div><div className="rowMeta">已发现公开数据回传</div></div></div>)}</div>}
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>最近公开数据</h2><span>{recent.length}</span></div>
        {recent.length === 0 ? <div className="empty">打开一个支持的平台页面后，数据会出现在这里。</div> : <div className="dataList">{recent.map((row) => <div className="row" key={row.id}><div><div className="rowTitle">{row.title}</div><div className="rowMeta">{row.detail}{row.machine ? ` · ${row.machine}` : ""}</div></div><div className="rowMeta">{new Date(row.time).toLocaleString()}</div></div>)}</div>}
      </section>
    </>
  );
}
