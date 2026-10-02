"use client";
/* fd/register — walkthrough A3, issue #5. Ported from docs/prototype/Setu Front Desk.dc.html (screen=register).
   Validation is @setu/domain validateRegistration (the API runs the same function); a blocked save shows
   "N fields need attention" and focuses the first one. A save made offline waits in the outbox, never "Saved". */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MatchCandidate, RegistrationInput } from "@setu/contracts";
import { format, normalizePhone, parseDob, validateRegistration, type RegistrationError } from "@setu/domain";
import { Button, Callout, Card, Pill, Segmented, SelectField, TextField, useToast } from "@setu/ui";
import { ApiFailure, fd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { PLACES, operatorOf, placeLabel, takePrefill, useLabels, useT } from "./common";

type Form = Omit<RegistrationInput, "guardian"> & { guardianName: string; guardianRel: string };
const EMPTY: Form = { nameBn: "", nameEn: "", sex: undefined, dobMode: "dob", dob: "", ageYears: "", ageMonths: "", phone: "", phoneOwner: "self", division: "", district: "", upazila: "", addressLine: "", guardianName: "", guardianRel: "", idType: "none", idNo: "" };
const ORDER = ["nameBn", "sex", "dob", "ageYears", "ageMonths", "guardianName", "guardianRelationship", "phone", "division", "district", "upazila", "idNo"];
const toInput = (f: Form): RegistrationInput => {
  const { guardianName, guardianRel, ...rest } = f;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== "" && v !== undefined)) as unknown as RegistrationInput;
  return { ...clean, nameBn: f.nameBn, dobMode: f.dobMode, ...(guardianName || guardianRel ? { guardian: { name: guardianName || undefined, relationship: guardianRel || undefined } } : {}) };
};

export function FrontDeskRegister() {
  const s = useSession(); const T = useT(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [f, setF] = useState<Form>(EMPTY);
  const [formKey, setFormKey] = useState(() => crypto.randomUUID());
  useEffect(() => { setFormKey(crypto.randomUUID()); }, [f]); // a changed form is a new request
  useEffect(() => { const p = takePrefill(); if (p.phone || p.nameBn || p.nameEn) setF((x) => ({ ...x, phone: p.phone ?? "", nameBn: p.nameBn ?? "", nameEn: p.nameEn ?? "", phoneOwner: p.phone ? "family" : "self" })); }, []);
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<RegistrationError[] | null>(null);
  const [save, setSave] = useState<{ st: "idle" | "saving" | "saved" | "queued" | "failed"; no?: string; patientId?: string }>({ st: "idle" });
  const [dups, setDups] = useState<{ st: "idle" | "checking" | "done"; list: MatchCandidate[] }>({ st: "idle", list: [] });
  const [phoneUsers, setPhoneUsers] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setF((x) => ({ ...x, [k]: v })); setServerErrors(null); if (save.st !== "saving") setSave({ st: "idle" }); };
  const input = useMemo(() => toInput(f), [f]);
  const errors = useMemo(() => serverErrors ?? validateRegistration(input, new Date()), [input, serverErrors]);
  const errOf = (field: string) => { if (!tried && !serverErrors) return undefined; const e = errors.find((x) => x.field === field); return e ? T(`e_${e.code}`) : undefined; };

  // Live duplicate check (register screen, right column) once there is a Bangla name and a phone or birth date.
  useEffect(() => {
    const phoneOk = Boolean(normalizePhone(f.phone));
    if (!/[ঀ-৿]/.test(f.nameBn) || !(phoneOk || parseDob(f.dob) || f.ageYears) || !s.online) { setDups({ st: "idle", list: [] }); return; }
    setDups((d) => ({ ...d, st: "checking" }));
    const h = setTimeout(async () => { try { setDups({ st: "done", list: (await fd.preview(input)).candidates }); } catch { setDups({ st: "idle", list: [] }); } }, 450);
    return () => clearTimeout(h);
  }, [f.nameBn, f.nameEn, f.phone, f.dob, f.ageYears, f.sex, f.guardianName, f.district, f.upazila, s.online]); // eslint-disable-line react-hooks/exhaustive-deps
  // "N patients already use this number"
  useEffect(() => {
    const d = normalizePhone(f.phone);
    if (!d || !s.online) { setPhoneUsers(null); return; }
    const h = setTimeout(async () => { try { setPhoneUsers((await fd.search("0" + d)).items.filter((p) => p.phone === d).length); } catch { setPhoneUsers(null); } }, 300);
    return () => clearTimeout(h);
  }, [f.phone, s.online]);

  const focusFirst = (list: RegistrationError[]) => {
    const first = [...list].sort((a, b) => ORDER.indexOf(a.field) - ORDER.indexOf(b.field))[0];
    const box = first && root.current?.querySelector<HTMLElement>(`[data-fld="${first.field}"]`);
    box?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
  };
  const submit = async (createVisit: boolean) => {
    setTried(true);
    if (errors.length) { focusFirst(errors); return; }
    setSave({ st: "saving" });
    try {
      const r = await fd.register({ ...input, createVisit }, `${formKey}:${createVisit ? "visit" : "save"}`);
      if (r.queued) { setSave({ st: "queued" }); return; }
      setSave({ st: "saved", no: r.data.patient.facilityNo, patientId: r.data.patient.id });
      if (r.data.encounter) router.push(`/m/fd/queue?sel=${r.data.encounter.id}&new=1`);
    } catch (e) {
      setSave({ st: "failed" });
      if (e instanceof ApiFailure && e.body.code === "validation" && e.body.fields) { const list = e.body.fields as RegistrationError[]; setServerErrors(list); focusFirst(list); }
      else toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert");
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); void submit(true); }
      else if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); void submit(false); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  const visitOn = async (patientId: string) => {
    try {
      const r = await fd.createVisit(patientId);
      if (r.queued) { toast(T("queued_offline"), "cloud-off"); return; }
      router.push(`/m/fd/queue?sel=${r.data.encounter.id}`);
    } catch (e) {
      if (e instanceof ApiFailure && e.body.code === "visit_exists") router.push(`/m/fd/queue?sel=${(e.body.existing as { encounterId?: string }).encounterId ?? ""}`);
      else toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : T("error_generic"), "triangle-alert");
    }
  };

  const div = f.division ? PLACES[f.division] : undefined;
  const dist = div && f.district ? div.districts[f.district] : undefined;
  const phoneD = normalizePhone(f.phone);
  const dobIso = f.dobMode === "dob" ? parseDob(f.dob) : null;
  const ageChip = f.dobMode === "dob"
    ? dobIso && new Date(dobIso) <= new Date() ? (() => { const a = format.age(new Date(dobIso)); return T("age_label_exact", { y: a.y, m: a.m }); })() : null
    : format.toEn(f.ageYears ?? "").replace(/\D/g, "") ? T("age_label_approx", { y: Number(format.toEn(f.ageYears ?? "").replace(/\D/g, "")), m: Number(format.toEn(f.ageMonths ?? "").replace(/\D/g, "") || 0) }) : null;
  const nErr = errors.length;
  const showSummary = (tried || serverErrors) && nErr > 0;

  return (
    <div ref={root} data-screen="fd/register" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0, paddingBottom: 72 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{T("reg_title")}</h1>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="eraser" onClick={() => { setF(EMPTY); setTried(false); setServerErrors(null); setSave({ st: "idle" }); }}>{T("clear")}</Button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 320px)", gap: 16, alignItems: "start" }} className="fd-split">
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
            <h3 className="t-h3" style={{ margin: 0 }}>{s.n(1)} · {T("sec_identity")}</h3>
            <div style={GRID2}>
              <div data-fld="nameBn"><TextField name="nameBn" label={T("name_bn")} lang="bn" value={f.nameBn} onChange={(e) => set("nameBn", e.target.value)} error={errOf("nameBn")} /></div>
              <div data-fld="nameEn"><TextField name="nameEn" label={T("name_en")} value={f.nameEn ?? ""} onChange={(e) => set("nameEn", e.target.value)} /></div>
            </div>
            <div style={GRID2}>
              <div data-fld="sex" className="field">
                <label>{T("sex")}</label>
                <Segmented label="Sex" value={(f.sex ?? "") as "female" | "male" | "other" | ""} onChange={(v) => set("sex", v as Form["sex"])}
                  options={[{ value: "female", label: L.sex("female") }, { value: "male", label: L.sex("male") }, { value: "other", label: L.sex("other") }]} />
                {errOf("sex") && <span className="field-error" role="alert">{errOf("sex")}</span>}
              </div>
              <div className="field">
                <label>{T("dob_or_age")}</label>
                <Segmented label="DOB or age" value={f.dobMode} onChange={(v) => set("dobMode", v)} options={[{ value: "dob", label: T("dob_mode_dob") }, { value: "age", label: T("dob_mode_age") }]} />
              </div>
            </div>
            {f.dobMode === "dob" ? (
              <div style={GRID2}>
                <div data-fld="dob"><TextField name="dob" label="DD/MM/YYYY" inputMode="numeric" placeholder="DD/MM/YYYY" value={f.dob ?? ""} onChange={(e) => set("dob", e.target.value)} error={errOf("dob")} hint={ageChip ?? undefined} /></div>
              </div>
            ) : (
              <div style={GRID2}>
                <div style={{ display: "flex", gap: 8 }}>
                  <div data-fld="ageYears" style={{ flex: 1 }}><TextField name="ageYears" label={T("years")} inputMode="numeric" value={s.n(f.ageYears ?? "")} onChange={(e) => set("ageYears", format.toEn(e.target.value).replace(/\D/g, "").slice(0, 3))} error={errOf("ageYears")} /></div>
                  <div data-fld="ageMonths" style={{ flex: 1 }}><TextField name="ageMonths" label={T("months")} inputMode="numeric" value={s.n(f.ageMonths ?? "")} onChange={(e) => set("ageMonths", format.toEn(e.target.value).replace(/\D/g, "").slice(0, 2))} error={errOf("ageMonths")} /></div>
                </div>
                {ageChip && <span style={{ alignSelf: "end", paddingBottom: 10 }}><Pill tone="neu" icon="circle-help">{ageChip}</Pill></span>}
              </div>
            )}
          </Card>

          <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
            <h3 className="t-h3" style={{ margin: 0 }}>{s.n(2)} · {T("sec_guardian")}</h3>
            <div style={GRID2}>
              <div data-fld="guardianName"><TextField name="guardianName" label={T("guardian_name")} value={f.guardianName} onChange={(e) => set("guardianName", e.target.value)} error={errOf("guardianName")} /></div>
              <div data-fld="guardianRelationship">
                <SelectField name="guardianRel" label={T("relationship")} value={f.guardianRel} onChange={(e) => set("guardianRel", e.target.value)} error={errOf("guardianRelationship")}>
                  <option value="">{T("choose")}</option>
                  {["husband", "wife", "father", "mother", "son", "daughter", "other"].map((r) => <option key={r} value={r}>{L.rel(r)}</option>)}
                </SelectField>
              </div>
            </div>
            <span className="t-small t-muted">{T("guardian_rule")}</span>
          </Card>

          <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
            <h3 className="t-h3" style={{ margin: 0 }}>{s.n(3)} · {T("sec_contact")}</h3>
            <div style={GRID2}>
              <div data-fld="phone">
                <TextField name="phone" label={T("mobile")} inputMode="tel" placeholder="01XXXXXXXXX" value={f.phone ?? ""} onChange={(e) => set("phone", e.target.value)} error={errOf("phone")}
                  hint={phoneD ? `${operatorOf(phoneD)} · ${phoneUsers ? T("phone_shared", { n: phoneUsers }) : T("phone_new")}` : T("phone_hint")} />
              </div>
              <div className="field">
                <label>{T("whose_number")}</label>
                <Segmented label="Phone owner" value={f.phoneOwner ?? "self"} onChange={(v) => set("phoneOwner", v)} options={[{ value: "self", label: T("owner_self") }, { value: "family", label: T("owner_family") }, { value: "other", label: T("owner_other") }]} />
              </div>
            </div>
            <div style={GRID3}>
              <div data-fld="division">
                <SelectField name="division" label={T("division")} value={f.division ?? ""} onChange={(e) => setF((x) => ({ ...x, division: e.target.value, district: "", upazila: "" }))} error={errOf("division")}>
                  <option value="">{T("choose")}</option>
                  {Object.entries(PLACES).map(([v, d]) => <option key={v} value={v}>{placeLabel(v, d.bn, s.lang)}</option>)}
                </SelectField>
              </div>
              <div data-fld="district">
                <SelectField name="district" label={T("district")} value={f.district ?? ""} onChange={(e) => setF((x) => ({ ...x, district: e.target.value, upazila: "" }))} error={errOf("district")} disabled={!div}>
                  <option value="">{div ? T("choose") : T("pick_division_first")}</option>
                  {div && Object.entries(div.districts).map(([v, d]) => <option key={v} value={v}>{placeLabel(v, d.bn, s.lang)}</option>)}
                </SelectField>
              </div>
              <div data-fld="upazila">
                <SelectField name="upazila" label={T("upazila")} value={f.upazila ?? ""} onChange={(e) => set("upazila", e.target.value)} error={errOf("upazila")} disabled={!dist}>
                  <option value="">{dist ? T("choose") : T("pick_district_first")}</option>
                  {dist?.upazilas.map(([v, bn]) => <option key={v} value={v}>{placeLabel(v, bn, s.lang)}</option>)}
                </SelectField>
              </div>
            </div>
            <TextField name="addressLine" label={T("area")} value={f.addressLine ?? ""} onChange={(e) => set("addressLine", e.target.value)} />
          </Card>

          <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
            <h3 className="t-h3" style={{ margin: 0 }}>{s.n(4)} · {T("sec_id")}</h3>
            <div style={GRID2}>
              <SelectField name="idType" label={T("id_type")} value={f.idType ?? "none"} onChange={(e) => set("idType", e.target.value as Form["idType"])}>
                {(["none", "nid", "brn", "passport"] as const).map((v) => <option key={v} value={v}>{T(`id_${v}`)}</option>)}
              </SelectField>
              <div data-fld="idNo"><TextField name="idNo" label={T("id_no")} inputMode="numeric" value={f.idNo ?? ""} onChange={(e) => set("idNo", e.target.value)} error={errOf("idNo")} hint={T("id_no_hint")} disabled={f.idType === "none"} /></div>
            </div>
          </Card>
        </div>

        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="dup-box">
          <b>{dups.st === "checking" ? T("dup_box_checking") : dups.list.length ? T("dup_box_n", { n: dups.list.length }) : T("dup_box_none")}</b>
          {dups.list.length > 0 && <span className="t-small t-muted">{T("dup_box_hint")}</span>}
          {dups.list.map((c) => (
            <div key={c.patient.id} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 8, border: "1px solid var(--border-subtle)", borderRadius: 8 }}>
              <b>{c.patient.nameBn}</b>
              <span className="t-small t-muted">{c.patient.nameEn} · <span className="num">{c.patient.facilityNo}</span> · {L.age(c.patient)} {L.sex(c.patient.sex)}</span>
              <span className="t-small num">{T("score", { n: c.comparison.score })}{c.comparison.conflicts.length ? ` · ${T("conflicts_note", { n: c.comparison.conflicts.length })}` : ""}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {/* One click only for a clean strong match; anything else must be checked on the match screen (clinical review). */}
                {c.canLink && <Button size="sm" icon="ticket" onClick={() => void visitOn(c.patient.id)}>{T("use_this_record")}</Button>}
                {c.comparison.isGuardian ? <Pill tone="neu">{T("is_guardian_note")}</Pill> : !c.canLink && <span className="t-small t-muted">{T("check_on_match")}</span>}
              </span>
            </div>
          ))}
        </Card>
      </div>

      <div className="card" style={{ position: "sticky", bottom: 0, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 16px", zIndex: 2 }}>
        <span className="t-small" role="status" data-testid="save-status" style={{ flex: "1 1 240px" }}>
          {save.st === "saving" ? T("saving") : save.st === "saved" ? T("saved_confirmed", { no: save.no ?? "" }) : save.st === "queued" ? T("saved_offline") : save.st === "failed" ? `${T("not_saved")} · ${T("kept_note")}` : ""}
        </span>
        {showSummary && <Button variant="danger" icon="triangle-alert" role="alert" onClick={() => focusFirst(errors)} data-testid="error-summary">{T("fields_need_attention", { n: nErr })}</Button>}
        {save.st === "saved" && save.patientId && <Button icon="ticket" onClick={() => void visitOn(save.patientId!)}>{T("create_visit")}</Button>}
        <Button icon="save" kbd="Ctrl S" disabled={save.st === "saving"} onClick={() => void submit(false)}>{T("save")}</Button>
        <Button variant="primary" icon="ticket" kbd="Ctrl Enter" disabled={save.st === "saving"} onClick={() => void submit(true)}>{T("save_and_visit")}</Button>
      </div>
      {!s.online && <Callout tone="warn" icon="cloud-off">{T("saved_offline")}</Callout>}
    </div>
  );
}
const GRID2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 } as const;
const GRID3 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 } as const;
