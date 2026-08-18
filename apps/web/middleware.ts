import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "media_ops_hub_session";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/collector/") ||
    path.startsWith("/_next/") ||
    path === "/favicon.ico"
  ) return NextResponse.next();
  if (path === "/login") {
    if (request.cookies.has(SESSION_COOKIE)) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }
  if (!request.cookies.has(SESSION_COOKIE)) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
