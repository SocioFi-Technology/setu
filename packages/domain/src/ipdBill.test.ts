import { describe, expect, it } from "vitest";
import {
  bedDaysDue, classPreview, dayClass, depositState, desiredLines, ipdLineAmounts, ipdTotals, reconcileLines, suggestedTopUp,
  type ClassLeg, type DesiredLine, type PackageSnapshot, type PostedLine, type StayFacts,
} from "./ipdBill.js";

const D = (s: string) => new Date(`${s}+06:00`); // Dhaka wall time
const RATES = {
  General: { perDayPaisa: 120_000, nameEn: "General ward", nameBn: "সাধারণ ওয়ার্ড" },
  Cabin: { perDayPaisa: 450_000, nameEn: "Cabin (AC)", nameBn: "কেবিন (এসি)" },
  HDU: { perDayPaisa: 800_000, nameEn: "HDU", nameBn: "এইচডিইউ" },
};
// walkthrough B8: the laparoscopic cystectomy package, 3 days, ward ৳48,000 / cabin ৳62,000
const LAP: PackageSnapshot = {
  packageId: "pkg1", code: "PKG-LAP-01", nameEn: "Laparoscopic cystectomy", nameBn: "ল্যাপারোস্কোপিক সিস্টেক্টমি", days: 3,
  prices: { General: 4_800_000, Cabin: 6_200_000 }, services: [{ code: "test:cbc", limit: 2 }], medicines: ["ketorolac"], excluded: [{ nameEn: "Blood", nameBn: "রক্ত" }],
};
const ADMIT = D("2026-09-29T11:40:00");
const stay = (over: Partial<StayFacts> = {}): StayFacts => ({
  admitAt: ADMIT, releasedAt: null, legs: [{ bedClass: "General", from: ADMIT, to: null }], rates: RATES, pkg: LAP,
  orders: [], stock: [], manual: [], ...over,
});
const byKey = (ls: DesiredLine[]) => new Map(ls.map((l) => [l.key, l]));

describe("bed days — midnight census, admission day = day 1 (Kamrul, 06/10/2026)", () => {
  it("day 1 at admit; day n from 00:01 Dhaka of its day; none after the release", () => {
    expect(bedDaysDue(ADMIT, null, ADMIT)).toBe(1);
    expect(bedDaysDue(ADMIT, null, D("2026-09-29T23:59:00"))).toBe(1);
    expect(bedDaysDue(ADMIT, null, D("2026-09-30T00:00:30"))).toBe(1);
    expect(bedDaysDue(ADMIT, null, D("2026-09-30T00:01:00"))).toBe(2);
    expect(bedDaysDue(ADMIT, null, D("2026-10-02T09:00:00"))).toBe(4);
    // released on day 3 at 11:40: day 3 was posted at its 00:01, nothing more
    expect(bedDaysDue(ADMIT, D("2026-10-01T11:40:00"), D("2026-10-05T09:00:00"))).toBe(3);
  });
  it("walkthrough B8: three days in the package (৳0, Included), day 4 Excluded at the ward rate", () => {
    const ls = byKey(desiredLines(stay(), D("2026-10-02T09:00:00")));
    expect(ls.get("pkg")).toMatchObject({ tag: "package", unitPaisa: 4_800_000, bedClass: "General" });
    for (const d of [1, 2, 3]) expect(ls.get(`bed:${d}`)).toMatchObject({ tag: "included", unitPaisa: 0, dayNo: d });
    expect(ls.get("bed:4")).toMatchObject({ tag: "excluded", unitPaisa: 120_000, serviceDay: "2026-10-02", nameEn: "Bed · day 4 · General ward (beyond package)" });
  });
  it("without a package every bed day is Excluded at its class's rate", () => {
    const ls = byKey(desiredLines(stay({ pkg: null }), D("2026-09-30T10:00:00")));
    expect(ls.has("pkg")).toBe(false);
    expect(ls.get("bed:1")).toMatchObject({ tag: "excluded", unitPaisa: 120_000 });
    expect(ls.get("bed:2")).toMatchObject({ tag: "excluded", unitPaisa: 120_000, nameEn: "Bed · day 2 · General ward" });
  });
});

describe("class changes (Kamrul, decision 3)", () => {
  const up: ClassLeg[] = [{ bedClass: "General", from: ADMIT, to: D("2026-09-30T15:00:00") }, { bedClass: "Cabin", from: D("2026-09-30T15:00:00"), to: null }];
  const down: ClassLeg[] = [{ bedClass: "Cabin", from: ADMIT, to: D("2026-09-30T15:00:00") }, { bedClass: "General", from: D("2026-09-30T15:00:00"), to: null }];
  it("moving up re-prices the current bed day to the higher class", () => {
    expect(dayClass(up, "2026-09-29", ADMIT, RATES)).toBe("General");
    expect(dayClass(up, "2026-09-30", ADMIT, RATES)).toBe("Cabin");
    const ls = byKey(desiredLines(stay({ pkg: null, legs: up }), D("2026-10-01T08:00:00")));
    expect([1, 2, 3].map((d) => ls.get(`bed:${d}`)!.unitPaisa)).toEqual([120_000, 450_000, 450_000]);
  });
  it("moving down applies from the next bed day — the day of the move stays at the higher class", () => {
    const ls = byKey(desiredLines(stay({ pkg: null, legs: down }), D("2026-10-01T08:00:00")));
    expect([1, 2, 3].map((d) => ls.get(`bed:${d}`)!.unitPaisa)).toEqual([450_000, 450_000, 120_000]);
  });
  it("the package follows the dearest class occupied so far: up raises it, down leaves it", () => {
    expect(byKey(desiredLines(stay({ legs: up }), D("2026-09-30T16:00:00"))).get("pkg")).toMatchObject({ unitPaisa: 6_200_000, bedClass: "Cabin" });
    expect(byKey(desiredLines(stay({ legs: down }), D("2026-10-01T08:00:00"))).get("pkg")).toMatchObject({ unitPaisa: 6_200_000, bedClass: "Cabin" });
    // before the move the package is still the ward price
    expect(byKey(desiredLines(stay({ legs: up }), D("2026-09-30T14:00:00"))).get("pkg")!.unitPaisa).toBe(4_800_000);
  });
  it("a class the package has no price for keeps the package price; days past the package go at that class's rate", () => {
    const hdu: ClassLeg[] = [{ bedClass: "General", from: ADMIT, to: D("2026-10-02T10:00:00") }, { bedClass: "HDU", from: D("2026-10-02T10:00:00"), to: null }];
    const ls = byKey(desiredLines(stay({ legs: hdu }), D("2026-10-02T12:00:00")));
    expect(ls.get("pkg")!.unitPaisa).toBe(4_800_000);
    expect(ls.get("bed:4")).toMatchObject({ tag: "excluded", unitPaisa: 800_000, bedClass: "HDU" });
  });
});

describe("services and stock: Included up to the package's limit, Excluded beyond", () => {
  it("CBC ×3 on a package of two: the first two Included in the order placed, the third Excluded at its price", () => {
    const orders = [3, 1, 2].map((h) => ({ id: `sr${h}`, code: "test:cbc", nameEn: "CBC", nameBn: "সিবিসি", unitPaisa: 40_000, vatRateBp: 0, at: D(`2026-09-30T0${h}:00:00`) }));
    const ls = byKey(desiredLines(stay({ orders }), D("2026-09-30T10:00:00")));
    expect(ls.get("order:sr1")).toMatchObject({ tag: "included", unitPaisa: 0 });
    expect(ls.get("order:sr2")).toMatchObject({ tag: "included", unitPaisa: 0 });
    expect(ls.get("order:sr3")).toMatchObject({ tag: "excluded", unitPaisa: 40_000 });
  });
  it("an unpriced order stays unpriced (it will block the final bill, as on an OPD bill)", () => {
    const orders = [{ id: "u1", code: "test:tsh", nameEn: "TSH", nameBn: "টিএসএইচ", unitPaisa: null, vatRateBp: 0, at: ADMIT }];
    expect(byKey(desiredLines(stay({ orders }), ADMIT)).get("order:u1")).toMatchObject({ tag: "excluded", unitPaisa: null });
  });
  it("walkthrough: Ceftriaxone 4 × ৳370 off the package list is Excluded; Ketorolac on it is Included; stock put back drops out", () => {
    const stock = [
      { key: "stock:administration:a1:b1", refId: "a1", batchId: "b1", medicineKey: "ceftriaxone", nameEn: "Inj. Ceftriaxone 1 g", nameBn: "ইনজে. সেফট্রিয়াক্সোন ১ গ্রাম", units: 4, unitPaisa: 37_000, vatRateBp: 0, at: D("2026-09-30T08:00:00") },
      { key: "stock:administration:a2:b2", refId: "a2", batchId: "b2", medicineKey: "ketorolac", nameEn: "Inj. Ketorolac", nameBn: "ইনজে. কিটোরোলাক", units: 2, unitPaisa: 5_000, vatRateBp: 0, at: D("2026-09-30T09:00:00") },
      { key: "stock:administration:a3:b1", refId: "a3", batchId: "b1", medicineKey: "ceftriaxone", nameEn: "Inj. Ceftriaxone 1 g", nameBn: "ইনজে. সেফট্রিয়াক্সোন ১ গ্রাম", units: 0, unitPaisa: 37_000, vatRateBp: 0, at: D("2026-09-30T10:00:00") },
    ];
    const ls = byKey(desiredLines(stay({ stock }), D("2026-09-30T12:00:00")));
    expect(ls.get("stock:administration:a1:b1")).toMatchObject({ tag: "excluded", unitPaisa: 37_000, qty: 4, batchId: "b1" });
    expect(ls.get("stock:administration:a2:b2")).toMatchObject({ tag: "included", unitPaisa: 0, qty: 2 });
    expect(ls.has("stock:administration:a3:b1")).toBe(false);
  });
  it("a manual charge counts against the same limits", () => {
    const orders = [{ id: "o1", code: "test:cbc", nameEn: "CBC", nameBn: "সিবিসি", unitPaisa: 40_000, vatRateBp: 0, at: D("2026-09-30T08:00:00") }];
    const manual = [{ id: "m1", code: "test:cbc", nameEn: "CBC", nameBn: "সিবিসি", unitPaisa: 40_000, vatRateBp: 0, qty: 2, at: D("2026-09-30T09:00:00") }];
    expect(byKey(desiredLines(stay({ orders, manual }), D("2026-09-30T10:00:00"))).get("manual:m1")).toMatchObject({ tag: "excluded", unitPaisa: 40_000, qty: 2 });
  });
});

describe("reconcile — supersede the changed, credit the gone, never edit (rule 3)", () => {
  const P = (id: string, key: string, over: Partial<PostedLine> = {}): PostedLine => ({ id, key, tag: "excluded", unitPaisa: 120_000, qty: 1, vatRateBp: 0, superseded: false, credited: false, creditOfId: null, ...over });
  it("a move up supersedes today's posted bed day and the package; unchanged lines stay", () => {
    const legs: ClassLeg[] = [{ bedClass: "General", from: ADMIT, to: D("2026-09-30T15:00:00") }, { bedClass: "Cabin", from: D("2026-09-30T15:00:00"), to: null }];
    const desired = desiredLines(stay({ legs }), D("2026-09-30T15:05:00"));
    const posted = [P("l0", "pkg", { tag: "package", unitPaisa: 4_800_000 }), P("l1", "bed:1", { tag: "included", unitPaisa: 0 }), P("l2", "bed:2", { tag: "included", unitPaisa: 0 })];
    const r = reconcileLines(posted, desired);
    expect(r.add).toEqual([]);
    expect(r.credit).toEqual([]);
    expect(r.supersede.map((x) => [x.oldId, x.line.unitPaisa, x.line.bedClass])).toEqual([["l0", 6_200_000, "Cabin"]]);
    // without a package, the bed day itself is re-priced
    const r2 = reconcileLines([P("l1", "bed:1"), P("l2", "bed:2")], desiredLines(stay({ legs, pkg: null }), D("2026-09-30T15:05:00")));
    expect(r2.supersede.map((x) => [x.oldId, x.line.unitPaisa])).toEqual([["l2", 450_000]]);
  });
  it("a cancelled order gets a credit line; one already credited or superseded is not touched again; a new day is added", () => {
    const desired = desiredLines(stay({ pkg: null }), D("2026-09-30T08:00:00"));
    const posted = [P("l1", "bed:1"), P("o1", "order:x", { unitPaisa: 40_000 }), P("o2", "order:y", { credited: true }), P("c2", "credit:order:y", { qty: -1, creditOfId: "o2" }), P("old", "bed:1", { superseded: true, unitPaisa: 99 })];
    const r = reconcileLines(posted, desired);
    expect(r.credit).toEqual(["o1"]);
    expect(r.add.map((l) => l.key)).toEqual(["bed:2"]);
    expect(r.supersede).toEqual([]);
  });
});

describe("totals and the deposit", () => {
  it("a credit line mirrors its original; superseded lines are left out", () => {
    expect(ipdLineAmounts(37_000, -4, 0)).toEqual({ grossPaisa: -148_000, discountPaisa: 0, netPaisa: -148_000, vatPaisa: 0, totalPaisa: -148_000 });
    const t = ipdTotals([
      { tag: "package", unitPaisa: 4_800_000, qty: 1, vatRateBp: 0, superseded: true },
      { tag: "package", unitPaisa: 6_200_000, qty: 1, vatRateBp: 0, superseded: false },
      { tag: "included", unitPaisa: 0, qty: 1, vatRateBp: 0, superseded: false },
      { tag: "excluded", unitPaisa: 37_000, qty: 4, vatRateBp: 0, superseded: false },
      { tag: "excluded", unitPaisa: 37_000, qty: -2, vatRateBp: 0, superseded: false },
      { tag: "excluded", unitPaisa: null, qty: 1, vatRateBp: 0, superseded: false },
    ]);
    expect(t).toEqual({ packagePaisa: 6_200_000, excludedPaisa: 74_000, includedLines: 1, subtotalPaisa: 6_274_000, vatPaisa: 0, totalPaisa: 6_274_000, unpriced: 1 });
  });
  it("low = under two days of the current class's rate; due = negative", () => {
    expect(depositState(275_000, 120_000)).toBe("ok"); // walkthrough B8's ৳2,750 on the ward: above ৳2,400
    expect(depositState(200_000, 120_000)).toBe("low");
    expect(depositState(275_000, 450_000)).toBe("low"); // the same balance in a cabin
    expect(depositState(-1, 120_000)).toBe("due");
    expect(suggestedTopUp(200_000, 120_000)).toBe(40_000);
    expect(suggestedTopUp(-100_000, 120_000)).toBe(340_000);
  });
});

describe("the class-change preview", () => {
  it("ward → cabin on day 2 of a 3-day package: today, the package difference, no bed day past the package in the next two", () => {
    const p = classPreview({ from: "General", to: "Cabin", rates: RATES, dayNo: 2, pkg: LAP, packageNowPaisa: 4_800_000 });
    expect(p).toMatchObject({ direction: "up", appliesFrom: "today", perDayFromPaisa: 120_000, perDayToPaisa: 450_000, packageFromPaisa: 4_800_000, packageToPaisa: 6_200_000, extraPaisa: 1_400_000 });
  });
  it("without a package: two bed days of the difference; moving down is a saving from tomorrow", () => {
    expect(classPreview({ from: "General", to: "Cabin", rates: RATES, dayNo: 1, pkg: null, packageNowPaisa: null }).extraPaisa).toBe(660_000);
    expect(classPreview({ from: "Cabin", to: "General", rates: RATES, dayNo: 1, pkg: null, packageNowPaisa: null })).toMatchObject({ direction: "down", appliesFrom: "tomorrow", extraPaisa: -660_000 });
    // moving down never lowers the package
    expect(classPreview({ from: "Cabin", to: "General", rates: RATES, dayNo: 2, pkg: LAP, packageNowPaisa: 6_200_000 })).toMatchObject({ packageToPaisa: 6_200_000, extraPaisa: -330_000 });
  });
});
