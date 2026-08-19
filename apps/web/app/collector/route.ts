import { NextRequest, NextResponse } from "next/server";

const apiTarget = (process.env.API_INTERNAL_URL || "http://api:8100").replace(/\/$/, "");

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Collector-Token",
  "Cache-Control": "no-store",
};

async function proxyRoot(request: NextRequest) {
  try {
    const headers = new Headers();
    for (const name of ["accept", "content-type", "cookie", "x-collector-token"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(`${apiTarget}/collector${request.nextUrl.search || ""}`, {
      method: request.method,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const data = await upstream.arrayBuffer();
    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    return new NextResponse(data.byteLength ? data : null, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    return NextResponse.json(
      { detail: `采集服务暂时不可用：主 API Collector 无法连接：${error instanceof Error ? error.message : String(error)}` },
      { status: 503, headers: corsHeaders },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  return proxyRoot(request);
}
