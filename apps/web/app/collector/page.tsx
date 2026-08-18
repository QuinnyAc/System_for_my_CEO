"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { AccountMetric, ContentMetric, PublishedContent, SocialAccount } from "@/lib/types";

type CollectorTask = {
  id: string;
  url: string;
  platform: string;
  machine_name: string | null;
  status: "pending" | "processing" | "completed" | "error";
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function sourceOf(extra: Record<string, unknown>) {
  return String(extra?.source || "");
}

function machineOf(extra: Record<string, unknown>) {
  return String(extra?.machine_name || "").trim();
}

async function collectorAdmin<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/collector/admin${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const statusLabel: Record<string, string> = {
  pending: "等待",
  processing: "正在读取",
  completed: "已完成",
  error: "失败",
};

export default function CollectorPage() {
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [contents, setContents] = useState<PublishedContent[]>([]);
  const [accountMetrics, setAccountMetrics] = useState<AccountMetric[]>([]);
  const [contentMetrics, setContentMetrics] = useState<ContentMetric[]>([]);
  const [tasks, setTasks] = useState<CollectorTask[]>([]);
  const [links, setLinks] = useState("");
  const [machineName, setMachineName] = useState("1");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const [a, c, am, cm, queue] = await Promise.all([
      api<SocialAccount[]>("/accounts"),
      api<PublishedContent[]>("/content"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
      api<ContentMetric[]>("/content/metrics/latest"),
      collectorAdmin<CollectorTask[]>("/tasks"),
    ]);
    setAccounts(a);
    setContents(c);
    setAccountMetrics(am);
    setContentMetrics(cm);
    setTasks(queue);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = setInterval(() => load().catch(() => null), 15_000);
    return () => clearInterval(timer);
  }, []);

  async function addTasks() {
    const urls = links.split(/\s+/).map((value) => value.trim()).filter(Boolean);
    if (!urls.length) {
      setError("请先粘贴至少一个视频或内容链接。");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await collectorAdmin<{ created: number; skipped: number }>("/tasks/batch", {
        method: "POST",
        body: JSON.stringify({ urls, machine_name: machineName.trim() || null }),
      });
      setNotice(`已加入 ${result.created} 条任务${result.skipped ? `，跳过 ${result.skipped} 条无效或重复链接` : ""}。电脑会自动开始读取。`);
      setLinks("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加任务失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTask(id: string) {
    if (!confirm("确定删除这条采集任务吗？已经写入的内容数据不会删除。")) return;
    await collectorAdmin(`/tasks/${id}`, { method: "DELETE" });
    await load();
  }

  async function retryTask(id: string) {
    await collectorAdmin(`/tasks/${id}/retry`, { method: "POST" });
    setNotice("任务已重新放回等待队列。");
    await load();
  }

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

  const queueCounts = useMemo(() => ({
    pending: tasks.filter((t) => t.status === "pending").length,
    processing: tasks.filter((t) => t.status === "processing").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    error: tasks.filter((t) => t.status === "error").length,
  }), [tasks]);

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Public View Collector</div>
          <h1>公开数据采集</h1>
          <p>默认模式。可以手动打开页面采集，也可以直接提交链接，让这台电脑在后台按顺序自动读取公开数据。</p>
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="section card">
        <div className="sectionTitle"><h2>自动采集链接队列</h2><span>一台电脑即可运行</span></div>
        <p className="rowMeta">把视频或内容链接粘贴到下面，一行一个。支持 YouTube、Instagram、Facebook、Pinterest。采集助手会在后台逐条打开，读取公开数字后自动关闭页面。</p>
        <label style={{ display: "block", marginTop: 14, fontWeight: 700 }}>链接</label>
        <textarea
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          placeholder={"https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/shorts/..."}
          style={{ width: "100%", minHeight: 150, marginTop: 8, padding: 12, boxSizing: "border-box", borderRadius: 12, border: "1px solid var(--border, #d1d5db)", resize: "vertical" }}
        />
        <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginTop: 12 }}>
          <div style={{ minWidth: 180 }}>
            <label style={{ display: "block", fontWeight: 700, marginBottom: 6 }}>执行电脑</label>
            <input value={machineName} onChange={(e) => setMachineName(e.target.value)} placeholder="1" style={{ width: "100%", padding: 10, boxSizing: "border-box", borderRadius: 10, border: "1px solid var(--border, #d1d5db)" }} />
          </div>
          <button className="button" disabled={saving} onClick={addTasks}>{saving ? "正在加入…" : "加入采集队列"}</button>
        </div>
        <div className="notice" style={{ marginTop: 12 }}>每条任务最多等待 60 秒；成功后约 12 秒继续下一条；失败最多自动重试 3 次。不会自动点赞、评论、关注，也不会绕过登录或验证码。</div>
      </section>

      <div className="grid">
        <div className="card"><div className="metricLabel">等待</div><div className="metricValue">{queueCounts.pending}</div><div className="metricMeta">尚未打开</div></div>
        <div className="card"><div className="metricLabel">正在读取</div><div className="metricValue">{queueCounts.processing}</div><div className="metricMeta">当前后台任务</div></div>
        <div className="card"><div className="metricLabel">已完成</div><div className="metricValue">{queueCounts.completed}</div><div className="metricMeta">队列历史</div></div>
        <div className="card"><div className="metricLabel">失败</div><div className="metricValue">{queueCounts.error}</div><div className="metricMeta">可重新尝试</div></div>
      </div>

      <section className="section">
        <div className="sectionTitle"><h2>采集任务</h2><span>{tasks.length}</span></div>
        {tasks.length === 0 ? <div className="empty">还没有自动采集任务。</div> : <div className="dataList">{tasks.slice(0, 100).map((task) => (
          <div className="row" key={task.id}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="rowTitle" style={{ overflowWrap: "anywhere" }}>{task.url}</div>
              <div className="rowMeta">{task.platform} · 电脑 {task.machine_name || "任意"} · {statusLabel[task.status] || task.status} · 尝试 {task.attempts}/3</div>
              {task.last_error ? <div className="rowMeta" style={{ marginTop: 4 }}>原因：{task.last_error}</div> : null}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {task.status === "error" ? <button className="button secondary" onClick={() => retryTask(task.id)}>重试</button> : null}
              <button className="button secondary" onClick={() => deleteTask(task.id)}>删除</button>
            </div>
          </div>
        ))}</div>}
      </section>

      <div className="grid">
        <div className="card"><div className="metricLabel">已回传电脑</div><div className="metricValue">{machineNames.length}</div><div className="metricMeta">按电脑名称去重</div></div>
        <div className="card"><div className="metricLabel">公开账号快照</div><div className="metricValue">{publicAccountMetrics.length}</div><div className="metricMeta">当前最新值</div></div>
        <div className="card"><div className="metricLabel">公开内容快照</div><div className="metricValue">{publicContentMetrics.length}</div><div className="metricMeta">当前最新值</div></div>
        <div className="card"><div className="metricLabel">最近回传</div><div className="metricValue" style={{ fontSize: 18 }}>{lastSeen ? lastSeen.toLocaleTimeString() : "—"}</div><div className="metricMeta">{lastSeen ? lastSeen.toLocaleDateString() : "尚无浏览器数据"}</div></div>
      </div>

      <section className="section">
        <div className="sectionTitle"><h2>最近公开数据</h2><span>{recent.length}</span></div>
        {recent.length === 0 ? <div className="empty">采集到数据后会出现在这里。</div> : <div className="dataList">{recent.map((row) => <div className="row" key={row.id}><div><div className="rowTitle">{row.title}</div><div className="rowMeta">{row.detail}{row.machine ? ` · 电脑 ${row.machine}` : ""}</div></div><div className="rowMeta">{new Date(row.time).toLocaleString()}</div></div>)}</div>}
      </section>
    </>
  );
}
