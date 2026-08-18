"use client";

import { useEffect, useMemo, useState } from "react";

type Monitor = {
  id: string;
  platform: "youtube" | "instagram" | "facebook" | "pinterest";
  name: string;
  profile_url: string;
  machine_name: string | null;
  enabled: boolean;
  discovered_count: number;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_error: string | null;
  created_at: string;
};

const platformLabels: Record<string, string> = {
  youtube: "YouTube（长视频 + 短视频）",
  instagram: "Instagram",
  facebook: "Facebook",
  pinterest: "Pinterest",
};

async function admin<T>(path: string, init?: RequestInit): Promise<T> {
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
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.detail || text;
    } catch {}
    throw new Error(message || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function MonitorsPage() {
  const [items, setItems] = useState<Monitor[]>([]);
  const [platform, setPlatform] = useState("youtube");
  const [name, setName] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [machineName, setMachineName] = useState("1");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setItems(await admin<Monitor[]>("/monitors"));
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = setInterval(() => load().catch(() => null), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function add() {
    if (!name.trim() || !profileUrl.trim()) {
      setError("请填写账号名称和账号主页链接。");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await admin<Monitor>("/monitors", {
        method: "POST",
        body: JSON.stringify({
          platform,
          name: name.trim(),
          profile_url: profileUrl.trim(),
          machine_name: machineName.trim() || null,
        }),
      });
      setName("");
      setProfileUrl("");
      setNotice("账号已加入自动监控。电脑会自动开始检查新作品。");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(item: Monitor) {
    await admin<Monitor>(`/monitors/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !item.enabled }),
    });
    await load();
  }

  async function checkNow(item: Monitor) {
    await admin<Monitor>(`/monitors/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    setNotice(`${item.name} 已安排立即检查，采集助手会在下一轮队列中处理。`);
    await load();
  }

  async function remove(item: Monitor) {
    if (!confirm(`确定停止并删除“${item.name}”的账号监控吗？已经采集的内容和数据不会删除。`)) return;
    await admin<void>(`/monitors/${item.id}`, { method: "DELETE" });
    await load();
  }

  const enabledCount = useMemo(() => items.filter((item) => item.enabled).length, [items]);
  const totalDiscovered = useMemo(() => items.reduce((sum, item) => sum + item.discovered_count, 0), [items]);

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Account Monitoring</div>
          <h1>账号监控</h1>
          <p>账号主页只登记一次。电脑会定时检查公开页面，自动发现新作品并加入数据采集队列。</p>
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className="grid">
        <div className="card"><div className="metricLabel">监控账号</div><div className="metricValue">{items.length}</div><div className="metricMeta">全部登记账号</div></div>
        <div className="card"><div className="metricLabel">正在监控</div><div className="metricValue">{enabledCount}</div><div className="metricMeta">自动检查开启</div></div>
        <div className="card"><div className="metricLabel">自动发现作品</div><div className="metricValue">{totalDiscovered}</div><div className="metricMeta">累计加入采集队列</div></div>
      </div>

      <section className="section card">
        <div className="sectionTitle"><h2>添加监控账号</h2><span>登记一次即可</span></div>
        <div className="form">
          <div className="field">
            <label>平台</label>
            <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="youtube">YouTube（长视频 + 短视频）</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
              <option value="pinterest">Pinterest</option>
            </select>
          </div>
          <div className="field"><label>账号名称</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Main Account" /></div>
          <div className="field full"><label>账号主页链接</label><input className="input" type="url" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder={platform === "youtube" ? "https://www.youtube.com/@username" : "https://..."} /></div>
          <div className="field"><label>执行电脑</label><input className="input" value={machineName} onChange={(e) => setMachineName(e.target.value)} placeholder="1" /></div>
          <div style={{ alignSelf: "end" }}><button className="button" disabled={saving} onClick={add}>{saving ? "正在添加…" : "开始监控"}</button></div>
        </div>
        <div className="notice" style={{ marginTop: 14 }}>
          YouTube 只需要填写一次频道主页，系统会自动检查长视频页和 Shorts 页。账号检查默认约每 60 分钟一次；新作品发现后会自动登记并进入数据更新周期。
        </div>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>监控列表</h2><span>{items.length}</span></div>
        {items.length === 0 ? <div className="empty">还没有监控账号。</div> : (
          <div className="dataList">
            {items.map((item) => (
              <div className="row" key={item.id} style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="rowTitle">{item.name} <span className="pill">{platformLabels[item.platform]}</span></div>
                  <div className="rowMeta" style={{ overflowWrap: "anywhere" }}>{item.profile_url}</div>
                  <div className="rowMeta" style={{ marginTop: 6 }}>
                    状态：<strong>{item.enabled ? "监控中" : "已暂停"}</strong> · 电脑 {item.machine_name || "任意"} · 已发现 {item.discovered_count} 条作品
                  </div>
                  <div className="rowMeta" style={{ marginTop: 4 }}>
                    最近检查：{item.last_checked_at ? new Date(item.last_checked_at).toLocaleString() : "尚未检查"} · 下次：{item.enabled && item.next_check_at ? new Date(item.next_check_at).toLocaleString() : "—"}
                  </div>
                  {item.last_error ? <div className="rowMeta" style={{ marginTop: 4 }}>最近错误：{item.last_error}</div> : null}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <button className="button secondary" onClick={() => checkNow(item)}>立即检查</button>
                  <button className="button secondary" onClick={() => toggle(item)}>{item.enabled ? "暂停" : "启用"}</button>
                  <button className="button danger" onClick={() => remove(item)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
