import type { ReactNode } from "react";
import "@setu/ui/styles/setu.css";
import "./patient.css";
import { LangProvider } from "../lib/lang";
export const metadata = { title: "Setu হেলথ পাসপোর্ট", manifest: "/manifest.webmanifest" };
export const viewport = { width: "device-width", initialScale: 1, themeColor: "#0f766e" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="bn"><body><LangProvider>{children}</LangProvider></body></html>;
}
