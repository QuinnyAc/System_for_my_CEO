"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const nav = [
  ["/", "总览", "Overview"],
  ["/accounts", "账号管理", "Accounts"],
  ["/content", "内容数据", "Content"],
  ["/analytics", "数据分析", "Analytics"],
  ["/settings", "API 设置", "Connections"]
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandStone">Z</div>
          <div><strong>ZenoMinerals</strong><span>自媒体运营平台</span></div>
        </div>
        <nav className="navList">
          {nav.map(([href, label, meta]) => (
            <Link className={`navItem ${pathname === href ? "active" : ""}`} href={href} key={href}>
              <span>{label}</span><small>{meta}</small>
            </Link>
          ))}
        </nav>
        <div className="sidebarNote">Independent workspace<br />YouTube · Instagram · Facebook · Pinterest</div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
