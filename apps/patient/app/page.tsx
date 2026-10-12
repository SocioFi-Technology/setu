"use client";
/* Home: records still to claim → the claim screen; otherwise the history. */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { patient } from "../lib/api";
import { useLang } from "../lib/lang";
export default function Home() {
  const router = useRouter(); const { T } = useLang();
  useEffect(() => {
    // a claim QR opened before the sign-in waits on the claim screen (ADR 0024)
    let qr = false; try { qr = !!sessionStorage.getItem("setu.claimqr"); } catch {}
    patient.me().then((m) => router.replace(qr || (m.counts.linked === 0 && m.counts.toClaim > 0) ? "/claim" : "/timeline")).catch(() => router.replace("/timeline"));
  }, [router]);
  return <div className="pa"><main className="pa-main"><p className="pa-sub">{T("loading")}</p></main></div>;
}
