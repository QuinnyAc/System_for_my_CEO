"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { api } from "@/lib/api";

const nav = [
  ["/", "总览", "Overview"],
  ["/accounts", "账号管理", "Accounts"],
  ["/content", "内容数据", "Content"],
  ["/sync", "同步中心", "Sync"],
  ["/analytics", "数据分析", "Analytics"],
  ["/settings", "API 设置", "Connections"],
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
        <div className="brand"><div className="brandStone">Z</div><div><strong>ZenoMinerals</strong><span>自媒体运营平台</span></div></div>
        <nav className="navList">{nav.map(([href, label, meta]) => <Link className={`navItem ${pathname === href ? "active" : ""}`} href={href} key={href}><span>{label}</span><small>{meta}</small></Link>)}</nav>
        <div className="sidebarNote">YouTube · Instagram · Facebook · Pinterest<br/><button className="button secondary" style={{ marginTop: 10, width: "100%" }} onClick={logout}>退出登录</button></div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
