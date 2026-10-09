import { NextResponse, type NextRequest } from "next/server";
/* ADR 0020: no patient session → the welcome screens. The API still authorizes every request; this only avoids an empty screen. */
export function middleware(req: NextRequest) {
  const has = req.cookies.has("setu_patient");
  const { pathname } = req.nextUrl;
  if (!has && pathname !== "/welcome") return NextResponse.redirect(new URL("/welcome", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/((?!api|_next|favicon.ico|manifest.webmanifest|icon).*)"] };
