"use client";
/* Module route. Access is decided by the API's capabilities (role + plan). Three states, as in the prototype:
   allowed → the module screen (ported per slice; placeholder until then) · plan locked → Not-in-plan panel · role denied → Permission-denied panel. */
import { use } from "react";
import { useRouter } from "next/navigation";
import { PLAN_NAME, ROLE_NAME } from "@setu/domain";
import { Button, PageState } from "@setu/ui";
import { useSession } from "../../../../../lib/session";
import { ModuleScreen } from "../../../../../modules/registry";

export default function ModulePage({ params }: { params: Promise<{ mod: string; screen: string }> }) {
  const { mod, screen } = use(params);
  const s = useSession(); const router = useRouter(); const bn = s.lang === "bn"; const L = s.L;
  const me = s.me!; const m = s.caps?.modules.find((x) => x.key === mod); const sc = m?.screens.find((x) => x.key === screen);
  const roleName = bn ? ROLE_NAME[me.role].bn : ROLE_NAME[me.role].en;
  const planName = PLAN_NAME[me.plan];
  const home = <Button onClick={() => router.push("/")}>{L("হোমে ফিরুন", "Back to home")}</Button>;

  if (!m || !sc || sc.reason === "role") {
    const what = sc ? (bn ? sc.name_bn : sc.name_en) : m ? (bn ? m.name_bn : m.name_en) : screen;
    return (
      <PageState icon="shield-off" title={L("প্রবেশাধিকার নেই", "You don’t have access")}
        body={L(`“${roleName}” ভূমিকায় ${what} দেখার অনুমতি নেই। এটি লুকানো নয় — নীতি অনুযায়ী বন্ধ।`, `The ${roleName} role cannot open ${what}. This is not hidden by mistake; it is closed by policy.`)}
        lines={[{ icon: "user-round", text: L("যিনি অনুমতি দিতে পারেন: অ্যাডমিন", "Who can grant it: Admin") }, { icon: "shield-check", text: L("অ্যাডমিন › ব্যবহারকারী ও ভূমিকা › অনুমতি ম্যাট্রিক্স", "Admin › Users & roles › Permission matrix") }]}
        actions={<><Button variant="primary" icon="send">{L("অনুমতির অনুরোধ পাঠান", "Request access")}</Button>{home}</>}
        foot={L("চেষ্টাটি অডিট লগে লেখা হয়েছে", "This attempt was written to the audit log")} />
    );
  }
  if (sc.reason === "plan") {
    const needs = sc.needs ? PLAN_NAME[sc.needs] : PLAN_NAME.pro;
    return (
      <PageState icon="lock" title={(bn ? sc.name_bn : sc.name_en) + " — " + L("এই প্ল্যানে নেই", "not in your plan")}
        body={L(`আপনার প্রতিষ্ঠান “${planName}” প্ল্যানে আছে। এই মডিউলটি ${needs} থেকে পাওয়া যায়।`, `Your facility is on the ${planName} plan. This module is available from ${needs}.`)}
        lines={[{ icon: "user-round", text: L("যিনি বদলাতে পারেন: মালিক", "Who can change this: Owner") }, { icon: "shield-check", text: L("অ্যাডমিন › সাবস্ক্রিপশন থেকে আপগ্রেড", "Upgrade from Admin › Subscription") }]}
        actions={<><Button variant="primary" icon="arrow-up" onClick={() => router.push("/m/adm/plan")}>{L("প্ল্যান দেখুন", "View plans")}</Button>{home}</>}
        foot={L("এই পাতা দেখা লগ হয়েছে", "This view is logged.")} />
    );
  }
  return <ModuleScreen mod={mod} screen={screen} />;
}
