import type { ReactNode } from "react";
import "@setu/ui/styles/setu.css";
import { SessionProvider } from "../lib/session";
import { ToastProvider } from "@setu/ui";
export const metadata = { title: "Setu Staff" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="bn">
      <body><SessionProvider><ToastProvider>{children}</ToastProvider></SessionProvider></body>
    </html>
  );
}
