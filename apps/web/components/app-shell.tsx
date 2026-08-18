"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/api";

const nav = [
  ["/", "总览", "Overview"],
  ["/monitors", "账号监控", "Auto Discover"],
  ["/collector", "公开数据采集", "Public View"],
  ["/accounts", "账号管理", "Accounts"],
  ["/content", "内容数据", "Content"],
  ["/analytics", "数据分析", "Analytics"],
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") return <>{children}</>;

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => null);
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand"><div className="brandStone">MO</div><div><strong>Media Ops</strong><span>自媒体运营平台</span></div></div>
        <nav className="navList">{nav.map(([href, label, meta]) => <Link className={`navItem ${pathname === href ? "active" : ""}`} href={href} key={href}><span>{label}</span><small>{meta}</small></Link>)}</nav>
        <div className="sidebarNote">YouTube 长视频 · YouTube 短视频 · Instagram · Facebook · Pinterest<br/><button className="button secondary" style={{ marginTop: 10, width: "100%" }} onClick={logout}>退出登录</button></div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
