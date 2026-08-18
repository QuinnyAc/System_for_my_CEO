"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, Platform, SocialAccount } from "@/lib/types";

type Monitor = {
  id: string;
  platform: string;
  profile_url: string;
};

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
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || text;
    } catch {}
    throw new Error(`${response.status} ${detail}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function normalizeProfileUrl(value: string, platformSlug: string) {
  const raw = value.trim();
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  let path = url.pathname.replace(/\/$/, "");
  if (platformSlug === "youtube") {
    for (const suffix of ["/videos", "/shorts", "/streams", "/featured"]) {
      if (path.endsWith(suffix)) {
        path = path.slice(0, -suffix.length);
        break;
      }
    }
  }
  url.pathname = path || "/";
  return url.toString().replace(/\/$/, "");
}

export default function AccountsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [platformId, setPlatformId] = useState("");
  const [name, setName] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [p, a, m, hiddenMonitors] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
      collectorAdmin<Monitor[]>("/monitors"),
    ]);
    setPlatforms(p);
    setAccounts(a);
    setMetrics(m);
    setMonitors(hiddenMonitors);
    if (!platformId && p[0]) setPlatformId(p[0].id);
  }

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const platform = pmap.get(platformId);
    if (!platform) {
      setError("请选择平台。");
      return;
    }

    let normalized = "";
    try {
      normalized = normalizeProfileUrl(profileUrl, platform.slug);
    } catch {
      setError("主页地址格式不正确。");
      return;
    }

    const duplicate = accounts.some((account) => {
      if (account.platform_id !== platformId || !account.profile_url) return false;
      try {
        return normalizeProfileUrl(account.profile_url, platform.slug) === normalized;
      } catch {
        return account.profile_url === normalized;
      }
    });
    if (duplicate) {
      setError("这个账号已经添加过了。");
      return;
    }

    setSaving(true);
    let created: SocialAccount | null = null;
    try {
      created = await api<SocialAccount>("/accounts", {
        method: "POST",
        body: JSON.stringify({
          platform_id: platformId,
          name: name.trim(),
          handle: null,
          external_id: null,
          profile_url: normalized,
        }),
      });

      try {
        await collectorAdmin<Monitor>("/monitors", {
          method: "POST",
          body: JSON.stringify({
            platform: platform.slug,
            name: name.trim(),
            profile_url: normalized,
            machine_name: null,
          }),
        });
      } catch (monitorError) {
        const message = monitorError instanceof Error ? monitorError.message : String(monitorError);
        if (!message.startsWith("409 ")) {
          if (created) await api<void>(`/accounts/${created.id}`, { method: "DELETE" }).catch(() => null);
          throw monitorError;
        }
      }

      setName("");
      setProfileUrl("");
      setNotice("账号已添加。后台已自动加入数据采集；首次检查建立现有作品基线，之后只记录新增作品。");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: SocialAccount) {
    if (!confirm(`确定删除账号“${a.name}”以及该账号下保存的内容和数据吗？`)) return;
    setError("");
    const platform = pmap.get(a.platform_id);
    if (platform && a.profile_url) {
      let target = a.profile_url;
      try { target = normalizeProfileUrl(a.profile_url, platform.slug); } catch {}
      const monitor = monitors.find((item) => {
        if (item.platform !== platform.slug) return false;
        try { return normalizeProfileUrl(item.profile_url, platform.slug) === target; } catch { return item.profile_url === target; }
      });
      if (monitor) {
        try {
          await collectorAdmin<void>(`/monitors/${monitor.id}`, { method: "DELETE" });
        } catch (e) {
          setError(`后台监控删除失败，账号暂未删除：${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
    }
    await api<void>(`/accounts/${a.id}`, { method: "DELETE" });
    setNotice("账号及后台采集监控已删除。");
    await load();
  }

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Accounts</div>
          <h1>账号管理</h1>
          <p>添加账号主页后，系统会在后台自动检查账号数据和新增作品，不需要再单独配置采集任务。</p>
        </div>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="card">
        <div className="sectionTitle"><h2>添加账号</h2><span>自动加入后台采集</span></div>
        <form className="form" onSubmit={submit}>
          <div className="field"><label>平台</label><select className="select" value={platformId} onChange={(e) => setPlatformId(e.target.value)}>{platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div className="field"><label>账号名称</label><input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Account 01" /></div>
          <div className="field full"><label>账号主页地址</label><input className="input" required type="url" value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://www.youtube.com/@username" /></div>
          <div><button className="button" type="submit" disabled={saving}>{saving ? "正在添加…" : "添加账号"}</button></div>
        </form>
        <div className="notice" style={{ marginTop: 14 }}>保存后后台自动读取粉丝数、视频总数，并建立当前作品基线。账号添加之后新发布的作品会自动进入「内容数据」。</div>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>已添加账号</h2><span>{accounts.length}</span></div>
        {accounts.length === 0 ? <div className="empty">暂无账号</div> : (
          <div className="dataList">
            {accounts.map((a) => {
              const m = mmap.get(a.id);
              const p = pmap.get(a.platform_id);
              return (
                <div className="row" key={a.id} style={{ alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="rowTitle">{a.name} <span className="pill">{p?.name || "Platform"}</span></div>
                    <div className="rowMeta">{m ? `${formatNumber(m.followers)} 粉丝/订阅 · ${formatNumber(m.content_count)} 视频/内容` : "等待首次账号数据同步"}</div>
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
