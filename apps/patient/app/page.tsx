"use client";
/* Home: records still to claim → the claim screen; otherwise the history. */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { patient } from "../lib/api";
import { useLang } from "../lib/lang";
export default function Home() {
  const router = useRouter(); const { T } = useLang();
  useEffect(() => {
    patient.me().then((m) => router.replace(m.counts.linked === 0 && m.counts.toClaim > 0 ? "/claim" : "/timeline")).catch(() => router.replace("/timeline"));
  }, [router]);
  return <div className="pa"><main className="pa-main"><p className="pa-sub">{T("loading")}</p></main></div>;
}
