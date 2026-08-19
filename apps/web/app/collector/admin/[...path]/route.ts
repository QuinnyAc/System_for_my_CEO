import { NextRequest, NextResponse } from "next/server";

const collectorTargets = Array.from(new Set([
  (process.env.COLLECTOR_INTERNAL_URL || "http://collector:8200").replace(/\/$/, ""),
  (process.env.COLLECTOR_HOST_URL || "http://host.docker.internal:8200").replace(/\/$/, ""),
]));

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function proxyAdmin(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const safePath = (path || []).map((segment) => encodeURIComponent(segment)).join("/");
  const search = request.nextUrl.search || "";
  const cookie = request.headers.get("cookie") || "";
  const contentType = request.headers.get("content-type") || "";
  const accept = request.headers.get("accept") || "application/json";
  const method = request.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const failures: string[] = [];

  for (const target of collectorTargets) {
    try {
      const headers = new Headers({ accept });
      if (cookie) headers.set("cookie", cookie);
      if (contentType) headers.set("content-type", contentType);
      const upstream = await fetch(`${target}/admin/${safePath}${search}`, {
        method,
        headers,
        body: body && body.byteLength ? body : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      const data = await upstream.arrayBuffer();
      return new NextResponse(data.byteLength ? data : null, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      failures.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return NextResponse.json(
    { detail: `采集管理服务暂时不可用：${failures.join("；")}` },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyAdmin(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyAdmin(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyAdmin(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyAdmin(request, context);
}
