import type { MetadataRoute } from "next";
/* installable on Android (ADR 0020): a home-screen app that opens without the browser bar */
export default function manifest(): MetadataRoute.Manifest {
  return { name: "Setu হেলথ পাসপোর্ট", short_name: "Setu", start_url: "/", display: "standalone", background_color: "#f7f7f5", theme_color: "#0f766e", lang: "bn",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
}
