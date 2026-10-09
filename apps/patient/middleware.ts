import { NextResponse, type NextRequest } from "next/server";
/* ADR 0020: no patient session → the welcome screens. The API still authorizes every request; this only avoids an empty screen. */
export function middleware(req: NextRequest) {
  const has = req.cookies.has("setu_patient");
  const { pathname } = req.nextUrl;
  // nextUrl keeps the base path (/patient on staging)
  if (!has && pathname !== "/welcome") { const u = req.nextUrl.clone(); u.pathname = "/welcome"; u.search = ""; return NextResponse.redirect(u); }
  return NextResponse.next();
}
export const config = { matcher: ["/((?!api|_next|favicon.ico|manifest.webmanifest|icon).*)"] };
