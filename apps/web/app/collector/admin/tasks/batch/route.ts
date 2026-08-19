import { NextRequest, NextResponse } from "next/server";

const collectorTarget = (process.env.COLLECTOR_INTERNAL_URL || "http://collector:8200").replace(/\/$/, "");

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ detail: "请求内容格式不正确" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${collectorTarget}/admin/tasks/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: request.headers.get("cookie") || "",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    const text = await upstream.text();
    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");

    return new NextResponse(text || null, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { detail: `采集服务暂时不可用：${detail}` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
