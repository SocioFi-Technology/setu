"use client";
import { useEffect, useState } from "react";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export default function Home() {
  const [health, setHealth] = useState<string>("checking…");
  useEffect(() => { fetch(API + "/health").then((r) => r.json()).then((j) => setHealth(`API ${j.version} · db ${j.db}`)).catch(() => setHealth("API not reachable on " + API)); }, []);
  return (
    <main style={{ padding: 32, maxWidth: 720 }}>
      <h1 style={{ margin: 0 }}>Setu Patient</h1>
      <p style={{ color: "#555" }}>Phase 0 shell. Screens are ported from the prototype one journey step at a time (see docs/BUILD-PLAN.md).</p>
      <p><strong>{health}</strong></p>
    </main>
  );
}
