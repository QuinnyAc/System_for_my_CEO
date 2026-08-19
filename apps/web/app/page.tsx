"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatNumber } from "@/lib/api";
import type { AccountMetric, Platform, PublishedContent, SocialAccount } from "@/lib/types";

type AccountMetricKey = "followers" | "content_count";
type MonitorRead = { id: string; platform: string; profile_url: string; enabled: boolean };

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

function metricKnown(metric: AccountMetric | undefined, key: AccountMetricKey) {
  if (!metric) return false;
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

function metricValue(metric: AccountMetric | undefined, key: AccountMetricKey) {
  return metricKnown(metric, key) && metric ? formatNumber(metric[key]) : "—";
}

function groupFallbackKey(name: string) {
  return `name:${name.trim().replace(/\s+/g, " ").toLocaleLowerCase()}`;
}

function sameProfile(left: string | null, right: string) {
  if (!left) return false;
  const clean = (value: string) => value.trim().replace(/\/$/, "").replace(/^https:\/\/www\./, "https://");
  return clean(left) === clean(right);
}

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

export default function Dashboard() {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [metrics, setMetrics] = useState<AccountMetric[]>([]);
  const [content, setContent] = useState<PublishedContent[]>([]);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const [p, a, m, c] = await Promise.all([
      api<Platform[]>("/platforms"),
      api<SocialAccount[]>("/accounts"),
      api<AccountMetric[]>("/accounts/metrics/latest"),
      api<PublishedContent[]>("/content"),
    ]);
    setPlatforms(p);
    setAccounts(a);
    setMetrics(m);
    setContent(c);
    setError("");
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "读取失败"));
    const timer = window.setInterval(() => load().catch(() => null), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const metricMap = useMemo(() => new Map(metrics.map((m) => [m.account_id, m])), [metrics]);
  const platformMap = useMemo(() => new Map(platforms.map((p) => [p.id, p])), [platforms]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const groups = useMemo<AccountGroupView[]>(() => {
    const map = new Map<string, AccountGroupView>();
    for (const account of accounts) {
      const key = account.group_id || groupFallbackKey(account.name);
      const current = map.get(key);
      if (current) current.accounts.push(account);
      else map.set(key, { key, name: account.name, accounts: [account] });
    }
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        accounts: [...group.accounts].sort((a, b) => {
          const aSlug = platformMap.get(a.platform_id)?.slug || "";
          const bSlug = platformMap.get(b.platform_id)?.slug || "";
          return (platformOrder[aSlug] || 99) - (platformOrder[bSlug] || 99);
        }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [accounts, platformMap]);

  const visibleContent = useMemo(() => content.filter((item) => {
    const account = accountMap.get(item.account_id);
    if (!account?.baseline_at) return false;
    return new Date(item.created_at).getTime() >= new Date(account.baseline_at).getTime();
  }), [content, accountMap]);

  const syncedAccounts = accounts.filter((account) => metricMap.has(account.id)).length;

  async function syncGroup(group: AccountGroupView) {
    setSyncing(group.key);
    setError("");
    setNotice("");
    try {
      const monitors = await collectorAdmin<MonitorRead[]>("/monitors");
      let queuedFeeds = 0;
      for (const account of group.accounts) {
        const platform = platformMap.get(account.platform_id);
        if (!platform || !account.profile_url) continue;
        const monitor = monitors.find((item) => item.platform === platform.slug && sameProfile(account.profile_url, item.profile_url));
        if (!monitor) continue;
        await collectorAdmin(`/monitors/${monitor.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: true }),
        });
        queuedFeeds += 1;
      }

      const groupAccountIds = new Set(group.accounts.map((account) => account.id));
      const urls = visibleContent
        .filter((item) => groupAccountIds.has(item.account_id) && item.url)
        .map((item) => item.url as string);
      if (urls.length) {
        await collectorAdmin("/tasks/batch", {
          method: "POST",
          body: JSON.stringify({ urls, machine_name: null }),
        });
      }

      if (!queuedFeeds) {
        throw new Error("没有找到该账号组对应的后台监控，请到账号管理确认主页地址。 ");
      }
      setNotice(`“${group.name}”已加入立即同步队列：正在检查 ${queuedFeeds} 个平台账号及已登记新作品。`);
      window.setTimeout(() => load().catch(() => null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "立即同步失败");
    } finally {
      setSyncing(null);
    }
  }

  return <>
    <header className="pageHeader">
      <div>
        <div className="eyebrow">Social Media Operations</div>
        <h1>运营总览</h1>
        <p>按账号名称归类，同一组内集中查看各平台粉丝数、作品数和同步状态。</p>
      </div>
    </header>
    {notice ? <div className="notice">{notice}</div> : null}
    {error ? <div className="error">{error}</div> : null}

    <div className="grid">
      <div className="card"><div className="metricLabel">账号组</div><div className="metricValue">{groups.length}</div><div className="metricMeta">按账号名称归类</div></div>
      <div className="card"><div className="metricLabel">平台账号</div><div className="metricValue">{accounts.length}</div><div className="metricMeta">YouTube / Pinterest / Instagram / Facebook</div></div>
      <div className="card"><div className="metricLabel">已有账号快照</div><div className="metricValue">{syncedAccounts}</div><div className="metricMeta">{accounts.length ? `${syncedAccounts}/${accounts.length} 个平台账号` : "暂无账号"}</div></div>
      <div className="card"><div className="metricLabel">登记后新作品</div><div className="metricValue">{visibleContent.length}</div><div className="metricMeta">不包含建立基线前的历史作品</div></div>
    </div>

    <section className="section">
      <div className="sectionTitle"><h2>账号快照</h2><span>{groups.length} groups</span></div>
      {groups.length === 0 ? <div className="empty">还没有账号。先到「账号管理」添加账号主页。</div> : (
        <div className="dataList">
          {groups.map((group) => {
            const capturedTimes = group.accounts
              .map((account) => metricMap.get(account.id)?.captured_at)
              .filter((value): value is string => Boolean(value));
            const lastSync = capturedTimes.length
              ? new Date(Math.max(...capturedTimes.map((value) => new Date(value).getTime()))).toLocaleString()
              : null;
            return (
              <div className="card" key={group.key} style={{ marginBottom: 14 }}>
                <div className="sectionTitle" style={{ marginBottom: 10 }}>
                  <h2 style={{ margin: 0 }}>{group.name}</h2>
                  <button className="button" onClick={() => syncGroup(group)} disabled={syncing === group.key}>
                    {syncing === group.key ? "正在同步…" : "立即同步"}
                  </button>
                </div>
                <div className="dataList">
                  {group.accounts.map((account) => {
                    const platform = platformMap.get(account.platform_id);
                    const metric = metricMap.get(account.id);
                    return (
                      <div className="row" key={account.id}>
                        <div>
                          <div className="rowTitle">{platform?.name || "Platform"}</div>
                          {account.profile_url ? <div className="rowMeta" style={{ overflowWrap: "anywhere" }}>{account.profile_url}</div> : null}
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div className="rowTitle">粉丝数：{metricValue(metric, "followers")}</div>
                          <div className="rowMeta">作品数：{metricValue(metric, "content_count")}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="rowMeta" style={{ marginTop: 12 }}>最后同步：{lastSync || "等待首次同步"}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  </>;
}
