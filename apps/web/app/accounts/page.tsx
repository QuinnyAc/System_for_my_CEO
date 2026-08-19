"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, Platform, SocialAccount } from "@/lib/types";

type AdminAccountResult = {
  account_id: string;
  monitor_id: string;
  platform: string;
  profile_url: string;
  account_created: boolean;
  monitor_created: boolean;
};

type AccountGroupView = {
  key: string;
  name: string;
  accounts: SocialAccount[];
};

const platformOrder: Record<string, number> = {
  youtube: 1,
  pinterest: 2,
  instagram: 3,
  facebook: 4,
};

async function collectorAdmin<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/collector/admin${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
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
    throw new Error(detail || `请求失败 (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function parseInputUrl(value: string) {
  const raw = value.trim();
  return new URL(raw.includes("://") ? raw : `https://${raw}`);
}

function detectPlatformSlug(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = parseInputUrl(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be" || host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("instagram.com")) return "instagram";
    if (host === "fb.watch" || host.endsWith("facebook.com")) return "facebook";
    if (host === "pin.it" || host.endsWith("pinterest.com")) return "pinterest";
  } catch {}
  return null;
}

function isContentReference(value: string) {
  try {
    const url = parseInputUrl(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be") return true;
    if (host.endsWith("youtube.com")) return url.pathname === "/watch" || ["shorts", "live"].includes(segments[0] || "");
    if (host.endsWith("instagram.com")) return ["p", "reel", "tv"].includes(segments[0] || "");
    if (host === "fb.watch") return true;
    if (host.endsWith("facebook.com")) {
      return /\/(posts|videos|reel|watch|photo|permalink)\b/i.test(url.pathname) || url.searchParams.has("story_fbid") || url.searchParams.has("fbid") || (url.pathname === "/watch" && url.searchParams.has("v"));
    }
    if (host === "pin.it") return true;
    if (host.endsWith("pinterest.com")) return segments[0] === "pin";
  } catch {}
  return false;
}

function metricKnown(metric: AccountMetric, key: "followers" | "content_count") {
  const extra = metric.extra_metrics || {};
  const known = extra.known;
  if (known && typeof known === "object" && typeof (known as Record<string, unknown>)[key] === "boolean") {
    return Boolean((known as Record<string, unknown>)[key]);
  }
  const available = extra.available;
  if (available && typeof available === "object" && typeof (available as Record<string, unknown>)[key] === "boolean") {
    return Boolean((available as Record<string, unknown>)[key]);
  }
  return metric[key] > 0;
}

function metricValue(metric: AccountMetric | undefined, key: "followers" | "content_count") {
  if (!metric || !metricKnown(metric, key)) return "—";
  return formatNumber(metric[key]);
}

function fallbackGroupKey(name: string) {
  return `name:${name.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
}

export default function AccountsPage() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [platformId, setPlatformId] = useState("");
  const [name, setName] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [saving, setSaving] = useState(false);
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
    setPlatformId((current) => current || p[0]?.id || "");
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = window.setInterval(() => load().catch(() => null), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const pmap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const mmap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);
  const groups = useMemo<AccountGroupView[]>(() => {
    const map = new Map<string, AccountGroupView>();
    for (const account of accounts) {
      const key = account.group_id || fallbackGroupKey(account.name);
      const current = map.get(key);
      if (current) current.accounts.push(account);
      else map.set(key, { key, name: account.name, accounts: [account] });
    }
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        accounts: [...group.accounts].sort((a, b) => {
          const aSlug = pmap.get(a.platform_id)?.slug || "";
          const bSlug = pmap.get(b.platform_id)?.slug || "";
          return (platformOrder[aSlug] || 99) - (platformOrder[bSlug] || 99);
        }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [accounts, pmap]);

  function updateProfileUrl(value: string) {
    setProfileUrl(value);
    const detected = detectPlatformSlug(value);
    const matched = platforms.find((p) => p.slug === detected);
    if (matched) setPlatformId(matched.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const detectedSlug = detectPlatformSlug(profileUrl);
    if (!detectedSlug) {
      setError("请填写 YouTube、Instagram、Facebook 或 Pinterest 的公开账号主页地址。");
      return;
    }
    if (isContentReference(profileUrl)) {
      setError("这里需要填写账号主页地址，不要填写单个视频、Reel、帖子或 Pin 的链接。");
      return;
    }
    const detectedPlatform = platforms.find((p) => p.slug === detectedSlug);
    if (!detectedPlatform) {
      setError("系统没有找到这个平台配置。");
      return;
    }
    const cleanName = name.trim().replace(/\s+/g, " ");
    if (!cleanName) {
      setError("请填写账号名称，例如 Zeno 01。");
      return;
    }
    setPlatformId(detectedPlatform.id);
    setSaving(true);
    try {
      const result = await collectorAdmin<AdminAccountResult>("/accounts", {
        method: "POST",
        body: JSON.stringify({
          platform: detectedPlatform.slug,
          name: cleanName,
          profile_url: profileUrl.trim(),
          machine_name: null,
        }),
      });
      setName("");
      setProfileUrl("");
      setNotice(
        result.account_created
          ? `${cleanName} 的 ${detectedPlatform.name} 主页已添加，并自动归入同名账号组。首次检查只建立历史作品基线。`
          : `这个 ${detectedPlatform.name} 主页已经存在，已确认后台监控继续启用。`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(account: SocialAccount) {
    const platform = pmap.get(account.platform_id);
    if (!confirm(`确定删除“${account.name}”的 ${platform?.name || "该平台"} 账号以及该平台下保存的内容和数据吗？`)) return;
    setError("");
    setNotice("");
    try {
      await collectorAdmin<void>(`/accounts/${account.id}`, { method: "DELETE" });
      setNotice("该平台账号、后台监控、作品数据和相关采集任务已删除；同组其他平台不受影响。");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }

  return (
    <>
      <header className="pageHeader">
        <div>
          <div className="eyebrow">Accounts</div>
          <h1>账号管理</h1>
          <p>每个平台主页仍由你手动添加。账号名称相同的 YouTube、Pinterest、Instagram、Facebook 会自动归入同一个账号组。</p>
        </div>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <section className="card">
        <div className="sectionTitle"><h2>添加平台账号</h2><span>同名自动归组</span></div>
        <form className="form" onSubmit={submit}>
          <div className="field">
            <label>平台</label>
            <select className="select" value={platformId} onChange={(e) => setPlatformId(e.target.value)}>
              {platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field"><label>账号名称</label><input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Zeno 01" /></div>
          <div className="field full"><label>账号主页地址</label><input className="input" required value={profileUrl} onChange={(e) => updateProfileUrl(e.target.value)} placeholder="https://www.youtube.com/@username" inputMode="url" /></div>
          <div><button className="button" type="submit" disabled={saving}>{saving ? "正在添加…" : "添加账号"}</button></div>
        </form>
        <div className="notice" style={{ marginTop: 14 }}>
          例如连续添加“Zeno 01”的 YouTube、Pinterest、Instagram 主页，它们会自动显示在同一个 Zeno 01 账号组中。每个平台首次检查只建立已有作品基线，之后新作品才进入「内容数据」。
        </div>
      </section>

      <section className="section">
        <div className="sectionTitle"><h2>已添加账号</h2><span>{groups.length} 个账号组 · {accounts.length} 个平台账号</span></div>
        {groups.length === 0 ? <div className="empty">暂无账号</div> : (
          <div className="dataList">
            {groups.map((group) => (
              <div className="card" key={group.key} style={{ marginBottom: 14 }}>
                <div className="sectionTitle" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>{group.name}</h2><span>{group.accounts.length} platforms</span></div>
                <div className="dataList">
                  {group.accounts.map((account) => {
                    const metric = mmap.get(account.id);
                    const platform = pmap.get(account.platform_id);
                    return (
                      <div className="row" key={account.id} style={{ alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="rowTitle">{platform?.name || "Platform"}</div>
                          <div className="rowMeta">{metricValue(metric, "followers")} 粉丝/订阅 · {metricValue(metric, "content_count")} 作品</div>
                          <div className="rowMeta" style={{ marginTop: 4 }}>{metric ? `最近同步：${new Date(metric.captured_at).toLocaleString()}` : "等待首次账号数据同步"}</div>
                          {account.profile_url ? <div className="rowMeta" style={{ marginTop: 4, overflowWrap: "anywhere" }}>{account.profile_url}</div> : null}
                        </div>
                        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {account.profile_url ? <a className="button secondary" href={account.profile_url} target="_blank" rel="noreferrer">打开主页</a> : null}
                          <button className="button danger" onClick={() => remove(account)}>删除</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
