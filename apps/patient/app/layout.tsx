import type { ReactNode } from "react";
import "@setu/ui/tokens/setu-tokens.css";
export const metadata = { title: "Setu Patient" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="bn"><body style={{ fontFamily: "var(--font-sans, system-ui)", margin: 0 }}>{children}</body></html>;
}
