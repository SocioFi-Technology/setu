"use client";
/* (Writes keep their Idempotency-Key until they succeed: a refusal stores nothing, so a retry with the same key is safe.)
   adm/wizard — journey G1 (ADR 0010). Ported from docs/prototype/Setu Admin.dc.html ("Facility onboarding"): the go-live
   checklist on the left, each step on the right — organization, branch, wards with beds (hospital plans), doctors
   (verified on the Users screen), the price list (Masters), print formats and payment methods, a test SMS — and Go live,
   which the server refuses until every required item is done. A live facility shows when it went live. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { FacilityView } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, SelectField, TextField, useToast } from "@setu/ui";
import { adm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useA, useErr, useFmt } from "./common";

const METHODS = ["cash", "card", "bank", "bkash", "nagad"] as const;

export function AdmWizard() {
  const s = useSession(); const A = useA(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [f, setF] = useState<FacilityView | null>(null); const [failed, setFailed] = useState(false); const [busy, setBusy] = useState(false);
  const [goKey, setGoKey] = useState(() => crypto.randomUUID()); const [setKey, setSetKey] = useState(() => crypto.randomUUID());
  const [org, setOrg] = useState({ name: "", nameBn: "", address: "", licenceNo: "" });
  const [branch, setBranch] = useState({ name: "", nameBn: "" }); const [ward, setWard] = useState({ name: "", beds: "4" });
  const [prints, setPrints] = useState<{ receiptFormat: "a5" | "thermal"; rxFormat: "a5" | "a4"; paymentMethods: string[] }>({ receiptFormat: "a5", rxFormat: "a5", paymentMethods: [] });
  const [phone, setPhone] = useState("");
  const show = useCallback((x: FacilityView) => {
    setF(x);
    setOrg({ name: x.name, nameBn: x.nameBn ?? "", address: x.address ?? "", licenceNo: x.licenceNo ?? "" });
    setPrints({ receiptFormat: x.settings.receiptFormat ?? "a5", rxFormat: x.settings.rxFormat ?? "a5", paymentMethods: x.settings.paymentMethods });
  }, []);
  // the first load: a re-run effect (React runs it twice in development) ignores the earlier answer, so a late answer
  // never resets what was already typed; later changes show the server's answer to each write
  useEffect(() => {
    let stale = false; s.setPatient(null);
    adm.facility().then((x) => { if (!stale) show(x); }).catch(() => { if (!stale) setFailed(true); });
    return () => { stale = true; };
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <PageState icon="building-2" title={A("error_generic")} />;
  if (!f) return <div aria-busy="true" className="t-muted">{A("loading")}</div>;
  const run = async (fn: () => Promise<FacilityView>, ok?: string) => { if (busy) return false; setBusy(true); try { show(await fn()); if (ok) toast(ok, "check"); return true; } catch (e) { toast(E(e), "triangle-alert"); return false; } finally { setBusy(false); } };
  const done = (item: string) => f.checklist.find((c) => c.item === item)?.done ?? false;
  const required = f.checklist.filter((c) => c.required);
  const left = required.filter((c) => !c.done);
  const live = f.status === "live";

  return (
    <div data-screen="adm/wizard" data-status={f.status} style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, position: "sticky", top: 72 }} data-testid="checklist">
        <b>{A("checklist")}</b>
        <span className="t-small t-secondary">{live ? A("live_since", { at: F.dateTime(f.liveAt) }) : A("items_left", { n: left.length, of: required.length })}</span>
        {f.checklist.map((c) => (
          <a key={c.item} href={`#step-${c.item}`} data-item={c.item} data-done={c.done ? "1" : "0"} style={{ display: "flex", gap: 8, alignItems: "center", textDecoration: "none", color: "inherit", opacity: c.required ? 1 : 0.6 }}>
            <Pill tone={c.done ? "ok" : c.required ? "pend" : "off"} icon={c.done ? "check" : c.required ? "circle" : "minus"}>{c.done ? A("done") : c.required ? A("to_do") : A("not_needed")}</Pill>
            <span className="t-small">{A(`item_${c.item}`)}</span>
          </a>
        ))}
        {live
          ? <Pill tone="ok" icon="radio">{A("status_live")}</Pill>
          : <Button variant="primary" icon="rocket" data-testid="go-live" disabled={!s.online || busy || left.length > 0}
              onClick={async () => { const ok = await run(() => adm.goLive(goKey), A("went_live")); if (ok) setGoKey(crypto.randomUUID()); }}>{left.length ? A("complete_first") : A("go_live")}</Button>}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h1 className="t-h2" style={{ margin: 0 }}>{A("wizard_title")}</h1>
          <Pill tone={live ? "ok" : "warn"} icon={live ? "radio" : "hammer"}>{live ? A("status_live") : A("status_setup")}</Pill>
          <span className="t-small t-secondary">{A(`plan_${f.plan}`)}</span>
        </div>
        {!live && <Callout tone="info" icon="info">{A("setup_note")}</Callout>}

        <Card id="step-organization" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="step-organization">
          <Step n={1} title={A("item_organization")} ok={done("organization")} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <TextField label={A("org_name_en")} value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} data-testid="org-name" />
            <TextField label={A("org_name_bn")} value={org.nameBn} onChange={(e) => setOrg({ ...org, nameBn: e.target.value })} data-testid="org-name-bn" />
            <TextField label={A("org_address")} value={org.address} onChange={(e) => setOrg({ ...org, address: e.target.value })} data-testid="org-address" />
            <TextField label={A("org_licence")} hint={A("org_licence_hint")} value={org.licenceNo} onChange={(e) => setOrg({ ...org, licenceNo: e.target.value })} data-testid="org-licence" />
          </div>
          <span><Button icon="save" data-testid="org-save" disabled={!s.online || busy || org.name.trim().length < 2} onClick={() => void run(() => adm.updateFacility({ name: org.name.trim(), nameBn: org.nameBn.trim() || undefined, address: org.address.trim() || undefined, licenceNo: org.licenceNo.trim() || undefined }), A("saved"))}>{A("save")}</Button></span>
        </Card>

        <Card id="step-branch" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="step-branch">
          <Step n={2} title={A("item_branch")} ok={done("branch")} />
          {f.branches.map((b) => <span key={b.id} className="t-small">• {s.lang === "bn" ? b.nameBn ?? b.name : b.name}</span>)}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <TextField label={A("branch_name_en")} value={branch.name} onChange={(e) => setBranch({ ...branch, name: e.target.value })} data-testid="branch-name" />
            <TextField label={A("branch_name_bn")} value={branch.nameBn} onChange={(e) => setBranch({ ...branch, nameBn: e.target.value })} />
            <Button icon="plus" data-testid="branch-add" disabled={!s.online || busy || branch.name.trim().length < 2} onClick={async () => { if (await run(() => adm.addBranch({ name: branch.name.trim(), nameBn: branch.nameBn.trim() || undefined }))) setBranch({ name: "", nameBn: "" }); }}>{A("add")}</Button>
          </div>
        </Card>

        <Card id="step-wards" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, opacity: f.plan === "clinic" ? 0.7 : 1 }} data-testid="step-wards">
          <Step n={3} title={A("item_wards")} ok={done("wards")} optional={f.plan === "clinic"} />
          {f.plan === "clinic" && <span className="t-small t-secondary">{A("wards_clinic")}</span>}
          {f.wards.map((w) => <span key={w.id} className="t-small">• {w.name} · {A("beds_n", { n: w.beds })}</span>)}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <TextField label={A("ward_name")} value={ward.name} onChange={(e) => setWard({ ...ward, name: e.target.value })} data-testid="ward-name" />
            <TextField label={A("ward_beds")} inputMode="numeric" value={ward.beds} onChange={(e) => setWard({ ...ward, beds: e.target.value })} data-testid="ward-beds" />
            <Button icon="plus" data-testid="ward-add" disabled={!s.online || busy || !ward.name.trim() || !/^\d+$/.test(ward.beds) || Number(ward.beds) < 1 || Number(ward.beds) > 100 || f.branches.length === 0}
              onClick={async () => { if (await run(() => adm.addWard({ name: ward.name.trim(), beds: Number(ward.beds) }))) setWard({ name: "", beds: "4" }); }}>{A("add")}</Button>
          </div>
          {f.branches.length === 0 && <span className="t-small t-muted">{A("branch_first")}</span>}
        </Card>

        <Card id="step-doctor" style={{ display: "flex", gap: 12, alignItems: "center", padding: 16, flexWrap: "wrap" }} data-testid="step-doctor">
          <Step n={4} title={A("item_doctor")} ok={done("doctor")} />
          <span className="t-small t-secondary" style={{ flex: 1 }}>{A("doctor_note")}</span>
          <Button icon="users" onClick={() => router.push("/m/adm/users")}>{A("open_users")}</Button>
        </Card>

        <Card id="step-price_list" style={{ display: "flex", gap: 12, alignItems: "center", padding: 16, flexWrap: "wrap" }} data-testid="step-price_list">
          <Step n={5} title={A("item_price_list")} ok={done("price_list")} />
          <span className="t-small t-secondary" style={{ flex: 1 }}>{A("price_note")}</span>
          <Button icon="tag" onClick={() => router.push("/m/adm/masters")}>{A("open_masters")}</Button>
        </Card>

        <Card id="step-templates" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="step-templates">
          <Step n={6} title={`${A("item_templates")} · ${A("item_payment_method")}`} ok={done("templates") && done("payment_method")} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <SelectField label={A("receipt_format")} value={prints.receiptFormat} onChange={(e) => setPrints({ ...prints, receiptFormat: e.target.value as "a5" | "thermal" })} data-testid="receipt-format">
              <option value="a5">{A("fmt_a5")}</option><option value="thermal">{A("fmt_thermal")}</option>
            </SelectField>
            <SelectField label={A("rx_format")} value={prints.rxFormat} onChange={(e) => setPrints({ ...prints, rxFormat: e.target.value as "a5" | "a4" })} data-testid="rx-format">
              <option value="a5">{A("fmt_a5")}</option><option value="a4">{A("fmt_a4")}</option>
            </SelectField>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 14, flexWrap: "wrap" }} data-testid="methods">
            <legend className="t-small" style={{ marginBottom: 6 }}>{A("payment_methods")}</legend>
            {METHODS.map((m) => (
              <label key={m} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={prints.paymentMethods.includes(m)} data-method={m}
                  onChange={(e) => setPrints({ ...prints, paymentMethods: e.target.checked ? [...prints.paymentMethods, m] : prints.paymentMethods.filter((x) => x !== m) })} /> {A(`m_${m}`)}
              </label>
            ))}
          </fieldset>
          <span><Button icon="save" data-testid="prints-save" disabled={!s.online || busy || prints.paymentMethods.length === 0}
            onClick={async () => { const x = f.settings; const ok = await run(() => adm.settings({ cashierLimitPaisa: x.cashierLimitPaisa, cashierLimitBp: x.cashierLimitBp, approverLimitPaisa: x.approverLimitPaisa, labelWidthMm: x.labelWidthMm, labelHeightMm: x.labelHeightMm, receiptFormat: prints.receiptFormat, rxFormat: prints.rxFormat, paymentMethods: prints.paymentMethods as FacilityView["settings"]["paymentMethods"] }, setKey), A("saved")); if (ok) setSetKey(crypto.randomUUID()); }}>{A("save")}</Button></span>
          {prints.paymentMethods.length === 0 && <span className="t-small t-muted">{A("method_needed")}</span>}
        </Card>

        <Card id="step-test_sms" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="step-test_sms">
          <Step n={7} title={A("item_test_sms")} ok={done("test_sms")} />
          {f.sms.testedAt && <span className="t-small">{A("sms_ok", { phone: F.n(f.sms.phone ?? ""), at: F.dateTime(f.sms.testedAt) })}</span>}
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <TextField label={A("sms_phone")} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="sms-phone" error={phone && !/^01[3-9]\d{8}$/.test(phone.trim()) ? A("phone_invalid") : undefined} />
            <Button icon="send" data-testid="sms-send" disabled={!s.online || busy || !/^01[3-9]\d{8}$/.test(phone.trim())} onClick={() => void run(() => adm.smsTest(phone.trim()), A("sms_sent"))}>{A("sms_send")}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Step({ n, title, ok, optional }: { n: number; title: string; ok: boolean; optional?: boolean }) {
  const A = useA(); const F = useFmt();
  return (
    <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <b className="num" style={{ width: 24, height: 24, borderRadius: 999, display: "inline-grid", placeItems: "center", background: "var(--surface-sunken)" }}>{F.n(n)}</b>
      <b>{title}</b>
      <Pill tone={ok ? "ok" : optional ? "off" : "pend"} icon={ok ? "check" : optional ? "minus" : "circle"}>{ok ? A("done") : optional ? A("not_needed") : A("to_do")}</Pill>
    </span>
  );
}
