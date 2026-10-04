import { NextResponse, type NextRequest } from "next/server";
/* Not signed in → /login. The API still authorizes every request; this only avoids rendering an empty shell. */
export function middleware(req: NextRequest) {
  const has = req.cookies.has("setu_session");
  const { pathname } = req.nextUrl;
  // The receipt QR opens a public page (no login; it shows facility, receipt number, date and amount only).
  if (pathname.startsWith("/verify/")) return NextResponse.next();
  // ADR 0011: the patient's phone opens the short payment link and lands on the result page — no login, no patient details
  if (pathname.startsWith("/p/") || pathname === "/pay/result") return NextResponse.next();
  if (!has && pathname !== "/login") return NextResponse.redirect(new URL("/login?next=" + encodeURIComponent(pathname), req.url));
  if (has && pathname === "/login") return NextResponse.redirect(new URL("/", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/((?!api|_next|favicon.ico).*)"] };
