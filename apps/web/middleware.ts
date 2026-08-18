import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path.startsWith("/api/") || path.startsWith("/_next/") || path === "/favicon.ico") return NextResponse.next();
  if (path === "/login") {
    if (request.cookies.has("zeno_social_ops_session")) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }
  if (!request.cookies.has("zeno_social_ops_session")) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
