import { describe, expect, it } from "vitest";
import { canLinkDirectly, compareRecords, concernsOf, isCandidate, linkAnywayAllowed, linkBlocked, normalizeName, normalizePhone, validateRegistration, type MatchRecord, type RegistrationInput } from "./patient.js";

const TODAY = new Date("2026-09-29T06:00:00Z");
const empty: RegistrationInput = { nameBn: "", dobMode: "dob" };
const ok: RegistrationInput = {
  nameBn: "রহিমা খাতুন", nameEn: "Rahima Khatun", sex: "female", dobMode: "dob", dob: "১৫/০৩/১৯৮৪",
  phone: "01711-234567", phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur",
};
const fields = (i: RegistrationInput) => validateRegistration(i, TODAY).map((e) => e.field);
const codeOf = (i: RegistrationInput, f: string) => validateRegistration(i, TODAY).find((e) => e.field === f)?.code;

describe("registration validation (walkthrough A3, issue #5)", () => {
  it("an empty form is blocked with 7 fields needing attention", () => {
    expect(fields(empty)).toEqual(["nameBn", "sex", "dob", "phone", "division", "district", "upazila"]);
  });
  it("a correctly filled form passes, with Bangla digits in the date and the phone", () => {
    expect(validateRegistration(ok, TODAY)).toEqual([]);
    expect(validateRegistration({ ...ok, phone: "০১৭১১২৩৪৫৬৭" }, TODAY)).toEqual([]);
  });
  it("the Bangla name must contain Bangla letters", () => {
    expect(codeOf({ ...ok, nameBn: "Rahima" }, "nameBn")).toBe("name_bn_script");
  });
  it("rejects an impossible date, a wrong format and a future date of birth", () => {
    expect(codeOf({ ...ok, dob: "31/02/2000" }, "dob")).toBe("dob_format");
    expect(codeOf({ ...ok, dob: "1984-03-15" }, "dob")).toBe("dob_format");
    expect(codeOf({ ...ok, dob: "01/01/2027" }, "dob")).toBe("dob_future");
  });
  it("a baby born today in Dhaka before 06:00 is not 'in the future' (Dhaka calendar day, not UTC)", () => {
    const earlyDhaka = new Date("2026-09-29T20:30:00Z"); // 30/09/2026 02:30 in Dhaka
    expect(validateRegistration({ ...ok, dob: "30/09/2026", guardian: { name: "রহিমা খাতুন", relationship: "mother" } }, earlyDhaka)).toEqual([]);
  });
  it("approximate age 0–120 years is accepted (Bangla digits too); 121 is not", () => {
    const a: RegistrationInput = { ...ok, dobMode: "age", dob: undefined, ageYears: "৪২", ageMonths: "৬" };
    expect(validateRegistration(a, TODAY)).toEqual([]);
    expect(codeOf({ ...a, ageYears: "121" }, "ageYears")).toBe("age_range");
    expect(codeOf({ ...a, ageYears: "" }, "ageYears")).toBe("age_required");
    expect(codeOf({ ...a, ageMonths: "12" }, "ageMonths")).toBe("age_months_range");
  });
  it("phone: 11 digits starting 01 after removing +880/0; short numbers fail", () => {
    expect(codeOf({ ...ok, phone: "171123" }, "phone")).toBe("phone_invalid");
    expect(codeOf({ ...ok, phone: "+880 1711-234567" }, "phone")).toBeUndefined();
    expect(codeOf({ ...ok, phone: "01211234567" }, "phone")).toBe("phone_invalid");
  });
  it("under 18 needs a guardian (name and relationship) — decided 02/10/2026: block the save", () => {
    const child: RegistrationInput = { ...ok, nameBn: "সুমাইয়া আক্তার", dob: "01/05/2017" };
    expect(fields(child)).toEqual(["guardianName", "guardianRelationship"]);
    expect(validateRegistration({ ...child, guardian: { name: "আব্দুল করিম", relationship: "father" } }, TODAY)).toEqual([]);
    expect(fields({ ...ok, dobMode: "age", dob: undefined, ageYears: "9" })).toEqual(["guardianName", "guardianRelationship"]);
  });
  it("an ID number, when given, must have the right number of digits", () => {
    expect(codeOf({ ...ok, idType: "nid", idNo: "12345" }, "idNo")).toBe("id_format");
    expect(codeOf({ ...ok, idType: "nid", idNo: "১২৩৪৫৬৭৮৯০" }, "idNo")).toBeUndefined();
    expect(codeOf({ ...ok, idType: "brn", idNo: "1234567890" }, "idNo")).toBe("id_format");
  });
});

describe("normalisation", () => {
  it("phone is stored as 10 digits after +880", () => {
    expect(normalizePhone("+880 1711-234567")).toBe("1711234567");
    expect(normalizePhone("০১৭১১২৩৪৫৬৭")).toBe("1711234567");
    expect(normalizePhone("12345")).toBeNull();
  });
  it("names ignore case, dots, extra spaces and the Md./Mst. prefix", () => {
    expect(normalizeName("  Md.  Abdul   KARIM ")).toBe("abdul karim");
    expect(normalizeName("মো. আব্দুল করিম")).toBe("আব্দুল করিম");
  });
});

/* Walkthrough A2: the new entry is Rahima Khatun; candidate 1 is her own record, candidate 2 is Rahima Begum. */
const NOW = new Date("2026-09-29T06:00:00Z");
const entry: MatchRecord = { nameBn: "রহিমা খাতুন", nameEn: "Rahima Khatun", sex: "female", birthDate: "1984-03-14", guardianName: "আব্দুল করিম", phone: "1711234567", district: "Dhaka", upazila: "Mirpur" };
const self: MatchRecord = { ...entry, birthDate: "1984-03-14", nid: "1984123456" };
const begum: MatchRecord = { nameBn: "রহিমা বেগম", nameEn: "Rahima Begum", sex: "female", birthDate: "1968-01-10", guardianName: "মো. হাশেম", phone: "1711234567", district: "Dhaka", upazila: "Pallabi" };

describe("field-level comparison (walkthrough A2, issue #4)", () => {
  it("her own record: everything Same except the NID the new entry lacks (Missing) — one-click link allowed", () => {
    const c = compareRecords(entry, self, NOW);
    expect(c.fields).toEqual({ nameBn: "same", nameEn: "same", sex: "same", birth: "same", guardian: "same", phone: "same", address: "same", id: "missing" });
    expect(c.score).toBe(7); expect(c.strong).toBe(true); expect(c.conflicts).toEqual([]);
    expect(canLinkDirectly(c)).toBe(true);
  });
  it("Rahima Begum conflicts on date of birth and guardian — never a one-click link", () => {
    const c = compareRecords(entry, begum, NOW);
    expect(c.fields.phone).toBe("same"); expect(c.fields.sex).toBe("same");
    expect(c.fields.nameBn).toBe("similar"); expect(c.fields.address).toBe("similar");
    expect(c.conflicts).toEqual(expect.arrayContaining(["birth", "guardian"]));
    expect(canLinkDirectly(c)).toBe(false);
  });
  it("Link anyway needs a reason of at least 10 characters (trimmed) and only applies when fields conflict", () => {
    const c = compareRecords(entry, begum, NOW);
    expect(linkAnywayAllowed(c, "  same woman ")).toBe(true);
    expect(linkAnywayAllowed(c, "  short   ")).toBe(false);
    expect(linkAnywayAllowed(compareRecords(entry, self, NOW), "a long enough reason")).toBe(false); // strong and clean: plain link
  });
  it("twins (names 2 letters apart, same birth, same everything else) are never a one-click link", () => {
    const a: MatchRecord = { nameBn: "হাসান আলী", nameEn: "Hasan Ali", sex: "male", birthDate: "2015-04-04", guardianName: "আব্দুল করিম", phone: "1711234567", district: "Dhaka", upazila: "Mirpur" };
    const b: MatchRecord = { ...a, nameBn: "হোসেন আলী", nameEn: "Hosen Ali" };
    const c = compareRecords(a, b, NOW);
    expect(c.conflicts).toEqual([]);
    expect(canLinkDirectly(c)).toBe(false);
    expect(linkAnywayAllowed(c, "confirmed with the father")).toBe(true);
    expect(concernsOf(c)).toEqual(expect.arrayContaining(["nameBn", "nameEn"]));
  });
  it("siblings 11 months apart and a thin old record (name + family phone only) are never a one-click link", () => {
    expect(canLinkDirectly(compareRecords(entry, { ...self, birthDate: "1985-02-01" }, NOW))).toBe(false);
    expect(canLinkDirectly(compareRecords(entry, { nameBn: "রহিমা খাতুন", phone: "1711234567" }, NOW))).toBe(false);
  });
  it("dates: within a year is Similar; approximate age within 2 years is Similar; otherwise Different", () => {
    expect(compareRecords(entry, { ...self, birthDate: "1984-11-01" }, NOW).fields.birth).toBe("similar");
    expect(compareRecords(entry, { ...self, birthDate: undefined, approxAgeYears: 41, approxAgeAt: "2026-01-01" }, NOW).fields.birth).toBe("similar");
    expect(compareRecords(entry, { ...self, birthDate: undefined, approxAgeYears: 30, approxAgeAt: "2026-01-01" }, NOW).fields.birth).toBe("different");
    expect(compareRecords(entry, { ...self, birthDate: undefined }, NOW).fields.birth).toBe("missing");
  });
  it("child on a parent's phone: the candidate who is the guardian cannot be linked at all", () => {
    const child: MatchRecord = { nameBn: "সুমাইয়া আক্তার", nameEn: "Sumaiya Akter", sex: "female", birthDate: "2017-05-01", guardianName: "আব্দুল করিম", phone: "1711234567", district: "Dhaka", upazila: "Mirpur" };
    const father: MatchRecord = { nameBn: "আব্দুল করিম", nameEn: "Abdul Karim", sex: "male", birthDate: "1979-02-02", phone: "1711234567", district: "Dhaka", upazila: "Mirpur" };
    const c = compareRecords(child, father, NOW);
    expect(c.isGuardian).toBe(true);
    expect(canLinkDirectly(c)).toBe(false);
    expect(linkAnywayAllowed(c, "this is definitely the same person")).toBe(false);
  });
  it("a shared family phone alone is not a possible match; a similar name on the same phone is", () => {
    const karim: MatchRecord = { nameBn: "আব্দুল করিম", nameEn: "Abdul Karim", sex: "male", birthDate: "1979-02-02", phone: "1711234567", district: "Dhaka", upazila: "Mirpur" };
    const ayesha: MatchRecord = { nameBn: "আয়েশা বেগম", nameEn: "Ayesha Begum", sex: "female", approxAgeYears: 71, approxAgeAt: "2026-09-01", phone: "1711234567", district: "Dhaka", upazila: "Mirpur" };
    expect(isCandidate(compareRecords(begum, karim, NOW))).toBe(false);
    expect(isCandidate(compareRecords(begum, ayesha, NOW))).toBe(false);
    expect(isCandidate(compareRecords(begum, self, NOW))).toBe(true);
  });
  it("a different sex blocks any link, even with a reason", () => {
    const c = compareRecords(entry, { ...self, sex: "male" }, NOW);
    expect(linkBlocked(c)).toBe(true);
    expect(linkAnywayAllowed(c, "patient insists it is them")).toBe(false);
  });
  it("guardian detection works both ways and on a near spelling", () => {
    const child: MatchRecord = { nameBn: "সুমাইয়া আক্তার", sex: "female", birthDate: "2017-05-01", guardianName: "রহিমা বেগম", phone: "1711234567", district: "Dhaka" };
    const mother: MatchRecord = { nameBn: "রহিমা খাতুন", nameEn: "Rahima Khatun", sex: "female", birthDate: "1984-03-14", phone: "1711234567", district: "Dhaka" };
    expect(compareRecords(child, mother, NOW).isGuardian).toBe(true); // "রহিমা বেগম" ~ "রহিমা খাতুন"
    const parentNew: MatchRecord = { nameBn: "আব্দুল করিম", sex: "male", birthDate: "1979-02-02", phone: "1711234567", district: "Dhaka" };
    const childOnFile: MatchRecord = { nameBn: "সুমাইয়া আক্তার", sex: "female", birthDate: "2017-05-01", guardianName: "আব্দুল করিম", phone: "1711234567", district: "Dhaka" };
    expect(compareRecords(parentNew, childOnFile, NOW).isGuardian).toBe(true); // registering the parent; the child's record names them
  });
});
