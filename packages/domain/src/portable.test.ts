/* ADR 0022 — the portable lab order (Journey E1–E2): a centre's offer and price, the patient's choice, the centre's
   decision (all, part, none — a reason of 10+ characters for each declined test), re-ordering declined tests, and who
   may see the order (the ordering facility, the patient, the chosen centre — nobody else). */
import { describe, expect, it } from "vitest";
import { canSeePortable, centreOffer, chooseCentreProblems, decideOrder, portableOrderNumber, reorderable, sortOffers, type CentreCatalogue } from "./portable.js";

const ITEMS = [{ id: "i1", testCode: "cbc" }, { id: "i2", testCode: "hba1c" }, { id: "i3", testCode: "usgwa" }];
const shapla: CentreCatalogue = { organizationId: "o_sh", nameEn: "Shapla", tests: [{ testCode: "cbc", unitPaisa: 42_750 }, { testCode: "hba1c", unitPaisa: 104_500 }, { testCode: "usgwa", unitPaisa: 171_000 }], homeCollection: true, homeCollectionFeePaisa: 20_000, turnaroundHours: 6 };
const padma: CentreCatalogue = { organizationId: "o_pd", nameEn: "Padma", tests: [{ testCode: "cbc", unitPaisa: 39_600 }, { testCode: "hba1c", unitPaisa: 96_800 }], homeCollection: true, homeCollectionFeePaisa: 20_000, turnaroundHours: 24 };
const none: CentreCatalogue = { organizationId: "o_x", nameEn: "X", tests: [{ testCode: "tsh", unitPaisa: 90_000 }], homeCollection: false, homeCollectionFeePaisa: 0, turnaroundHours: 4 };

describe("the order number", () => {
  it("LO-YYMM-NNNN in Latin digits", () => {
    expect(portableOrderNumber("2609", 441)).toBe("LO-2609-0441");
    expect(portableOrderNumber("2610", 12345)).toBe("LO-2610-12345");
  });
});

describe("a centre's offer", () => {
  it("what it offers at its prices, what it does not, the total; home collection adds its fee", () => {
    expect(centreOffer(ITEMS, padma, "centre")).toEqual({ organizationId: "o_pd", offered: [{ itemId: "i1", testCode: "cbc", unitPaisa: 39_600 }, { itemId: "i2", testCode: "hba1c", unitPaisa: 96_800 }], notOffered: ["i3"], testsPaisa: 136_400, homeFeePaisa: 0, totalPaisa: 136_400, turnaroundHours: 24, usable: true });
    expect(centreOffer(ITEMS, padma, "home")).toMatchObject({ homeFeePaisa: 20_000, totalPaisa: 156_400 });
  });
  it("home collection where the centre does not do it is not offered", () => {
    expect(centreOffer(ITEMS, { ...padma, homeCollection: false }, "home")).toMatchObject({ homeFeePaisa: 0, usable: false });
  });
  it("a centre offering none of the tests is not usable", () => {
    expect(centreOffer(ITEMS, none, "centre")).toMatchObject({ offered: [], notOffered: ["i1", "i2", "i3"], usable: false });
  });
  it("sorted by price or by turnaround; unusable centres left out; more tests offered first", () => {
    const offers = [shapla, padma, none].map((c) => centreOffer(ITEMS, c, "centre"));
    expect(sortOffers(offers, "price").map((o) => o.organizationId)).toEqual(["o_sh", "o_pd"]);
    expect(sortOffers([centreOffer(ITEMS.slice(0, 2), shapla, "centre"), centreOffer(ITEMS.slice(0, 2), padma, "centre")], "price").map((o) => o.organizationId)).toEqual(["o_pd", "o_sh"]);
    expect(sortOffers([centreOffer(ITEMS.slice(0, 2), shapla, "centre"), centreOffer(ITEMS.slice(0, 2), padma, "centre")], "turnaround").map((o) => o.organizationId)).toEqual(["o_sh", "o_pd"]);
  });
});

describe("choosing a centre", () => {
  it("only an order waiting for a centre, only a centre that offers something", () => {
    expect(chooseCentreProblems("active", centreOffer(ITEMS, padma, "centre"))).toEqual([]);
    expect(chooseCentreProblems("centre-chosen", centreOffer(ITEMS, padma, "centre"))).toEqual(["not_waiting"]);
    expect(chooseCentreProblems("active", centreOffer(ITEMS, none, "centre"))).toEqual(["nothing_offered"]);
  });
});

describe("the centre's decision", () => {
  const offered = (ids: string[]) => ITEMS.map((i) => ({ ...i, offered: ids.includes(i.id) }));
  it("all accepted → accepted", () => {
    const d = decideOrder("centre-chosen", offered(["i1", "i2", "i3"]), [{ itemId: "i1", accept: true }, { itemId: "i2", accept: true }, { itemId: "i3", accept: true }]);
    expect(d).toMatchObject({ ok: true, status: "accepted", items: [{ itemId: "i1", accept: true }, { itemId: "i2", accept: true }, { itemId: "i3", accept: true }] });
  });
  it("part: a reason (10+ characters) for each declined test → partially-accepted; a test not offered is declined for that", () => {
    const d = decideOrder("centre-chosen", offered(["i1", "i2", "i3"]), [{ itemId: "i1", accept: true }, { itemId: "i2", accept: true }, { itemId: "i3", accept: false, reason: "Sonologist unavailable until 02/10" }]);
    expect(d).toMatchObject({ ok: true, status: "partially-accepted" });
    const p = decideOrder("centre-chosen", offered(["i1", "i2"]), [{ itemId: "i1", accept: true }, { itemId: "i2", accept: true }]);
    expect(p).toMatchObject({ ok: true, status: "partially-accepted", items: expect.arrayContaining([{ itemId: "i3", accept: false, reason: null, notOffered: true }]) });
  });
  it("none → declined", () => {
    expect(decideOrder("centre-chosen", offered(["i1"]), [{ itemId: "i1", accept: false, reason: "Machine under repair this week" }])).toMatchObject({ ok: true, status: "declined" });
  });
  it("refused: a short reason, an undecided offered test, accepting a test not offered, an unknown item, a second decision", () => {
    expect(decideOrder("centre-chosen", offered(["i1", "i2", "i3"]), [{ itemId: "i1", accept: true }, { itemId: "i2", accept: true }, { itemId: "i3", accept: false, reason: "busy" }])).toEqual({ ok: false, problems: [{ itemId: "i3", code: "reason_too_short" }] });
    expect(decideOrder("centre-chosen", offered(["i1", "i2"]), [{ itemId: "i1", accept: true }])).toEqual({ ok: false, problems: [{ itemId: "i2", code: "undecided" }] });
    expect(decideOrder("centre-chosen", offered(["i1"]), [{ itemId: "i1", accept: true }, { itemId: "i3", accept: true }])).toEqual({ ok: false, problems: [{ itemId: "i3", code: "not_offered" }] });
    expect(decideOrder("centre-chosen", offered(["i1"]), [{ itemId: "i1", accept: true }, { itemId: "zz", accept: true }])).toEqual({ ok: false, problems: [{ itemId: "zz", code: "unknown_item" }] });
    expect(decideOrder("accepted", offered(["i1"]), [{ itemId: "i1", accept: true }])).toEqual({ ok: false, problems: [{ itemId: null, code: "not_waiting" }] });
  });
});

describe("re-ordering declined tests elsewhere", () => {
  it("declined tests not re-ordered yet; never an accepted one, never twice", () => {
    expect(reorderable([{ id: "i1", status: "accepted", reorderedToId: null }, { id: "i2", status: "declined", reorderedToId: null }, { id: "i3", status: "declined", reorderedToId: "po2" }])).toEqual(["i2"]);
  });
});

describe("who may see the order", () => {
  const order = { originTenantId: "t_gl", originPatientId: "p1", centreTenantId: null as string | null, status: "active" as const };
  it("the ordering facility; the patient (their linked record); nobody else before a centre is chosen", () => {
    expect(canSeePortable(order, { kind: "staff", tenantId: "t_gl" })).toBe(true);
    expect(canSeePortable(order, { kind: "person", linked: [{ tenantId: "t_gl", patientId: "p1" }] })).toBe(true);
    expect(canSeePortable(order, { kind: "person", linked: [{ tenantId: "t_gl", patientId: "p_sister" }] })).toBe(false);
    expect(canSeePortable(order, { kind: "staff", tenantId: "t_sh" })).toBe(false);
  });
  it("the chosen centre, after it is chosen; never another centre", () => {
    const chosen = { ...order, centreTenantId: "t_sh", status: "centre-chosen" as const };
    expect(canSeePortable(chosen, { kind: "staff", tenantId: "t_sh" })).toBe(true);
    expect(canSeePortable(chosen, { kind: "staff", tenantId: "t_pd" })).toBe(false);
  });
});
