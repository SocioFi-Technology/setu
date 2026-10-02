/* FakeMessenger and the SMS templates (slice A8–A11, ADR 0006). No database. */
import { describe, expect, it } from "vitest";
import { SMS_TEMPLATES, smsPlaceholdersOk } from "@setu/domain";
import { t } from "@setu/i18n";
import { FakeMessenger } from "../src/adapters/messaging/index.js";

const msg = (messageId: string, to = "01711234567") => ({ messageId, to, text: "Green Life Clinic: Your lab report is ready." });

describe("FakeMessenger", () => {
  it("records a delivered SMS; the same message id is never delivered twice (retry is idempotent)", async () => {
    const m = new FakeMessenger();
    const a = await m.sendSms(msg("com_1"));
    expect(a.status).toBe("delivered");
    const again = await m.sendSms(msg("com_1"));
    expect(again).toEqual(a);
    expect(m.deliveredMessages()).toHaveLength(1);
    expect(m.log().map((x) => x.outcome)).toEqual(["delivered", "already-delivered"]);
  });
  it("failNext makes the next send fail like an unreachable number; the retry of that message is delivered once", async () => {
    const m = new FakeMessenger();
    m.failNext();
    expect(await m.sendSms(msg("com_2"))).toEqual({ status: "failed", error: "number unreachable", providerRef: null });
    expect((await m.sendSms(msg("com_2"))).status).toBe("delivered");
    expect((await m.sendSms(msg("com_2"))).status).toBe("delivered");
    expect(m.deliveredMessages().map((x) => x.messageId)).toEqual(["com_2"]);
  });
  it("a number that is not a Bangladesh mobile fails without being recorded as sent", async () => {
    const m = new FakeMessenger();
    expect(await m.sendSms(msg("com_3", "12345"))).toMatchObject({ status: "failed", error: "invalid number" });
    expect(m.deliveredMessages()).toEqual([]);
  });
});

describe("SMS templates (CLAUDE.md: no clinical content in an SMS)", () => {
  it("every template, in both languages, fills in only the facility name and carries no digits", () => {
    for (const key of Object.values(SMS_TEMPLATES)) {
      for (const lang of ["bn", "en"] as const) {
        const text = t(lang, "labApp", key);
        expect(text).not.toBe(key);
        expect(smsPlaceholdersOk(text)).toBe(true);
        expect(text).not.toMatch(/[0-9০-৯]/);
      }
    }
  });
  it("no template names a result, a test, a diagnosis or a value", () => {
    const words = /(potassium|haemoglobin|sugar|glucose|critical|high|low|positive|negative|result value|cbc|rbs|diagnos|পটাশিয়াম|হিমোগ্লোবিন|সুগার|জরুরি|বেশি|কম)/i;
    for (const key of Object.values(SMS_TEMPLATES)) for (const lang of ["bn", "en"] as const) expect(t(lang, "labApp", key)).not.toMatch(words);
  });
});
