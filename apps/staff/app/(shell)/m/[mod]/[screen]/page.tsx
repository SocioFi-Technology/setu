"use client";
/* Module route. Access is decided by the API's capabilities (role + plan). Three states, as in the prototype:
   allowed → the module screen (ported per slice; placeholder until then) · plan locked → Not-in-plan panel · role denied → Permission-denied panel. */
import { use } from "react";
import { useRouter } from "next/navigation";
import { PLAN_NAME, ROLE_NAME } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, PageState } from "@setu/ui";
import { useSession } from "../../../../../lib/session";
import { ModuleScreen } from "../../../../../modules/registry";

export default function ModulePage({ params }: { params: Promise<{ mod: string; screen: string }> }) {
  const { mod, screen } = use(params);
  const s = useSession(); const router = useRouter(); const bn = s.lang === "bn";
  const L = (key: string, vars: Record<string, string> = {}) => fill(s.t("shellApp", key), vars);
  const me = s.me!; const m = s.caps?.modules.find((x) => x.key === mod); const sc = m?.screens.find((x) => x.key === screen);
  const roleName = bn ? ROLE_NAME[me.role].bn : ROLE_NAME[me.role].en;
  const planName = PLAN_NAME[me.plan];
  const home = <Button onClick={() => router.push("/")}>{L("page_back_home")}</Button>;

  if (!m || !sc || sc.reason === "role") {
    const what = sc ? (bn ? sc.name_bn : sc.name_en) : m ? (bn ? m.name_bn : m.name_en) : screen;
    return (
      <PageState icon="shield-off" title={L("denied_title")}
        body={L("denied_body", { role: roleName, what })}
        lines={[{ icon: "user-round", text: L("denied_who") }, { icon: "shield-check", text: L("denied_where") }]}
        actions={<><Button variant="primary" icon="send">{L("denied_request")}</Button>{home}</>}
        foot={L("denied_foot")} />
    );
  }
  if (sc.reason === "plan") {
    const needs = sc.needs ? PLAN_NAME[sc.needs] : PLAN_NAME.pro;
    return (
      <PageState icon="lock" title={(bn ? sc.name_bn : sc.name_en) + " — " + L("plan_not_in_plan")}
        body={L("plan_body", { plan: planName, needs })}
        lines={[{ icon: "user-round", text: L("plan_who") }, { icon: "shield-check", text: L("plan_where") }]}
        actions={<><Button variant="primary" icon="arrow-up" onClick={() => router.push("/m/adm/plan")}>{L("plan_view")}</Button>{home}</>}
        foot={L("plan_foot")} />
    );
  }
  return <ModuleScreen mod={mod} screen={screen} />;
}
