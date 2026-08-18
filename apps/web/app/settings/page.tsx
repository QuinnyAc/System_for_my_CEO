"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ProviderStatus } from "@/lib/types";

export default function SettingsPage() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<ProviderStatus>("/providers/status").then(setStatus).catch((e) => setError(e.message));
  }, []);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("回调地址已复制");
    } catch {
      setError("无法自动复制，请手动复制回调地址");
    }
  }

  const cards = status ? [
    { name: "YouTube", ready: status.youtube.oauth, fallback: status.youtube.api_key, callback: status.youtube.callback_url, detail: "Google OAuth 用于绑定实际频道；API Key 可作为公开频道/公开视频数据的轻量同步方式。" },
    { name: "Instagram", ready: status.instagram.oauth, fallback: false, callback: status.instagram.callback_url, detail: "通过 Meta 官方授权连接 Professional 账号并读取账号及媒体数据。" },
    { name: "Facebook", ready: status.facebook.oauth, fallback: false, callback: status.facebook.callback_url, detail: "通过 Meta 官方授权连接可管理的 Facebook Page 及内容数据。" },
    { name: "Pinterest", ready: status.pinterest.oauth, fallback: false, callback: status.pinterest.callback_url, detail: "通过 Pinterest OAuth 连接账号并读取 Pins 与可获得的 Organic 数据。" },
  ] : [];

  return (
    <>
      <header className="pageHeader"><div><div className="eyebrow">Connections</div><h1>API 设置</h1><p>这里只显示配置状态，不显示任何 Secret 值。平台凭据只保存在这个网站自己的运行环境里。</p></div></header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      {!status ? <div className="empty">正在读取 API 配置状态…</div> : (
        <div className="platformGrid">
          {cards.map((card) => <div className="platformCard" key={card.name}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}><strong>{card.name}</strong><span className="pill">{card.ready ? "OAuth 已配置" : card.fallback ? "API Key 已配置" : "待配置"}</span></div>
            <p>{card.detail}</p>
            <div className="rowMeta" style={{ overflowWrap: "anywhere" }}>OAuth 回调：{card.callback}</div>
            <button className="button secondary" style={{ marginTop: 10 }} onClick={() => copy(card.callback)}>复制回调地址</button>
          </div>)}
        </div>
      )}
      <section className="section card">
        <div className="sectionTitle"><h2>运行环境变量</h2><span>仅显示名称</span></div>
        <div className="rowMeta" style={{ lineHeight: 1.9 }}>
          CREDENTIALS_SECRET<br/>
          YOUTUBE_API_KEY<br/>
          GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET<br/>
          META_APP_ID / META_APP_SECRET / META_GRAPH_VERSION<br/>
          PINTEREST_APP_ID / PINTEREST_APP_SECRET
        </div>
      </section>
    </>
  );
}
