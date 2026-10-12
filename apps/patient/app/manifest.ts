import type { MetadataRoute } from "next";
/* installable on Android (ADR 0020): a home-screen app that opens without the browser bar */
export default function manifest(): MetadataRoute.Manifest {
  return { name: "Chartis Passport · চার্টিস পাসপোর্ট", short_name: "Chartis", start_url: (process.env.NEXT_PUBLIC_BASE_PATH ?? "") + "/", display: "standalone", background_color: "#f6f5f1", theme_color: "#0e5e52", lang: "bn",
    icons: [{ src: (process.env.NEXT_PUBLIC_BASE_PATH ?? "") + "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
}
