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
    {
      name: "YouTube",
      ready: status.youtube.oauth,
      fallback: status.youtube.api_key,
      callback: status.youtube.callback_url,
      detail: "Google OAuth 绑定实际频道；API Key 可作为公开频道/公开视频数据的轻量同步方式。",
      requirements: [
        "Google Cloud：启用 YouTube Data API v3",
        "Google Cloud：启用 YouTube Analytics API",
        "OAuth Client 类型：Web application",
        "权限：youtube.readonly + yt-analytics.readonly",
      ],
    },
    {
      name: "Instagram",
      ready: status.instagram.oauth,
      fallback: false,
      callback: status.instagram.callback_url,
      detail: "通过 Meta 官方授权连接 Instagram Professional 账号并读取账号及媒体数据。",
      requirements: [
        "Instagram 必须为 Professional（Business / Creator）账号",
        "账号需连接到可管理的 Facebook Page",
        "当前集成请求 instagram_basic / instagram_manage_insights",
        "同时请求 pages_show_list / pages_read_engagement / read_insights",
      ],
    },
    {
      name: "Facebook",
      ready: status.facebook.oauth,
      fallback: false,
      callback: status.facebook.callback_url,
      detail: "通过 Meta 官方授权连接可管理的 Facebook Page 及内容数据。",
      requirements: [
        "Meta Developer App",
        "当前集成请求 pages_show_list / pages_read_engagement / read_insights",
        "授权用户需要对目标 Facebook Page 有管理权限",
        "Instagram 与 Facebook 共用同一 Meta App，可分别建立账号记录",
      ],
    },
    {
      name: "Pinterest",
      ready: status.pinterest.oauth,
      fallback: false,
      callback: status.pinterest.callback_url,
      detail: "通过 Pinterest OAuth 连接账号并读取 Pins 与 Organic 数据。",
      requirements: [
        "Pinterest Developer App 并获得 API access",
        "权限：user_accounts:read / pins:read",
        "Authorization Code OAuth",
        "系统使用 continuous refresh token 自动续期",
      ],
    },
  ] : [];

  return (
    <>
      <header className="pageHeader"><div><div className="eyebrow">Connections</div><h1>API 设置</h1><p>这里只显示配置状态，不显示任何 Secret 值。平台凭据只保存在这个网站自己的运行环境里。</p></div></header>
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="error">{error}</div> : null}
      {!status ? <div className="empty">正在读取 API 配置状态…</div> : (
        <div className="platformGrid">
          {cards.map((card) => {
            const callbackIsLocal = card.callback.includes("localhost") || card.callback.includes("127.0.0.1");
            return <div className="platformCard" key={card.name}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}><strong>{card.name}</strong><span className="pill">{card.ready ? "OAuth 已配置" : card.fallback ? "API Key 已配置" : "待配置"}</span></div>
              <p>{card.detail}</p>
              <div className="rowMeta" style={{ marginTop: 8, lineHeight: 1.75 }}>
                {card.requirements.map((item) => <div key={item}>• {item}</div>)}
              </div>
              <div className="rowMeta" style={{ marginTop: 10, overflowWrap: "anywhere" }}>OAuth 回调：{card.callback}</div>
              {callbackIsLocal ? <div className="error" style={{ marginTop: 8 }}>当前仍是 localhost 回调。正式授权前请重新运行 Codespace 启动脚本，让系统写入公开 3100 地址。</div> : <div className="notice" style={{ marginTop: 8 }}>回调地址已使用公开网站地址。</div>}
              <button className="button secondary" style={{ marginTop: 10 }} onClick={() => copy(card.callback)}>复制回调地址</button>
            </div>;
          })}
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
        <p className="rowMeta" style={{ marginTop: 10 }}>Secret 不写入源码。取得平台凭据后，在 Codespace 运行 <code>bash .devcontainer/configure-api-env.sh</code>，脚本会隐藏输入 Secret 并只保存到本地 .env。</p>
      </section>
    </>
  );
}
