"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

type AuthStatus = { authenticated: boolean };

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    api<AuthStatus>("/auth/status")
      .then((status) => {
        if (status.authenticated) {
          router.replace("/");
          router.refresh();
        }
      })
      .catch(() => null);
  }, [router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
    <div className="card" style={{ width: "min(430px,100%)", padding: 28 }}>
      <div className="brand" style={{ padding: "0 0 24px" }}><div className="brandStone">MO</div><div><strong>Media Ops</strong><span>自媒体运营平台</span></div></div>
      <div className="eyebrow">Workspace Login</div>
      <h1 style={{ fontSize: 26, margin: "8px 0" }}>登录</h1>
      <p style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.6 }}>请输入工作台账号和密码。</p>
      {error ? <div className="error">{error}</div> : null}
      <form className="form" style={{ gridTemplateColumns: "1fr" }} onSubmit={submit}>
        <div className="field"><label>用户名</label><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus /></div>
        <div className="field"><label>密码</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
        <button className="button" disabled={loading}>{loading ? "登录中…" : "进入工作台"}</button>
      </form>
    </div>
  </div>;
}
