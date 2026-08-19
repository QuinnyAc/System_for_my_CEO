import { NextRequest, NextResponse } from "next/server";

const apiTarget = (process.env.API_INTERNAL_URL || "http://api:8100").replace(/\/$/, "");

export const dynamic = "force-dynamic";

type BatchBody = {
  urls?: unknown;
  machine_name?: unknown;
  [key: string]: unknown;
};

type AdminTask = {
  id: string;
  url: string;
  status: string;
  machine_name?: string | null;
};

type Monitor = {
  id: string;
  profile_url: string;
  machine_name?: string | null;
};

function normalizedUrl(value: string) {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function profileBase(value: string) {
  const normalized = normalizedUrl(value);
  return normalized.replace(/\/(videos|shorts)$/i, "").replace(/\/$/, "");
}

async function collectorRequest(path: string, cookie: string, init?: RequestInit) {
  try {
    return await fetch(`${apiTarget}/collector${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        cookie,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(
      `主 API Collector 无法连接：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function POST(request: NextRequest) {
  let body: BatchBody;
  try {
    body = (await request.json()) as BatchBody;
  } catch {
    return NextResponse.json({ detail: "请求内容格式不正确" }, { status: 400 });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  const requestedUrls = new Set(urls.map(normalizedUrl));
  const requestedProfiles = new Set(urls.map(profileBase));
  const cookie = request.headers.get("cookie") || "";
  let recovered = 0;
  let monitorsReleased = 0;

  try {
    // Immediate sync must be able to recover tasks that were created under an
    // old computer name. Otherwise an unassigned/default collector can never
    // lease them and every click only reports "already queued" forever.
    if (requestedUrls.size) {
      const tasksResponse = await collectorRequest("/admin/tasks", cookie);
      if (tasksResponse.ok) {
        const tasks = (await tasksResponse.json()) as AdminTask[];
        const blocked = tasks.filter(
          (task) => requestedUrls.has(normalizedUrl(task.url)) && ["pending", "processing"].includes(task.status),
        );
        for (const task of blocked) {
          const response = await collectorRequest(`/admin/tasks/${task.id}`, cookie, { method: "DELETE" });
          if (response.ok || response.status === 404) recovered += 1;
        }
      }

      // Also release the monitor from any historic machine assignment so the
      // next hourly automatic check is queued as an unassigned task too.
      const monitorsResponse = await collectorRequest("/admin/monitors", cookie);
      if (monitorsResponse.ok) {
        const monitors = (await monitorsResponse.json()) as Monitor[];
        const matching = monitors.filter(
          (monitor) => requestedProfiles.has(profileBase(monitor.profile_url)) && Boolean(monitor.machine_name),
        );
        for (const monitor of matching) {
          const response = await collectorRequest(`/admin/monitors/${monitor.id}`, cookie, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ machine_name: "" }),
          });
          if (response.ok) monitorsReleased += 1;
        }
      }
    }

    const upstream = await collectorRequest("/admin/tasks/batch", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, machine_name: null }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return new NextResponse(text || null, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const result = text ? JSON.parse(text) : {};
    return NextResponse.json(
      { ...result, recovered, monitors_released: monitorsReleased },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { detail: `采集服务暂时不可用：${detail}` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
