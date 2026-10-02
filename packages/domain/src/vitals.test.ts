import { describe, expect, it } from "vitest";
import { assessVitals, bmi, bmiClass, bpComponents, parseVital, type VitalsInput } from "./vitals.js";

const lv = (i: VitalsInput, f: string) => assessVitals(i).fields.find((x) => x.field === f);

describe("vitals: impossible values block the save (walkthrough A4)", () => {
  it("BP: systolic > 300 or < 40, diastolic > 200, or diastolic ≥ systolic", () => {
    for (const bp of [[310, 90], [35, 20], [150, 210], [120, 120], [110, 130]] as const)
      expect(lv({ bpSys: bp[0], bpDia: bp[1] }, "bp")?.level).toBe("impossible");
  });
  it("BP needs both numbers", () => {
    expect(lv({ bpSys: 120 }, "bp")).toMatchObject({ level: "impossible", code: "bp_incomplete" });
  });
  it("temperature 994 °F (the prototype's error demo), pulse 300, SpO₂ 101, RBS 45, weight 400, height 20 are impossible", () => {
    const a = assessVitals({ temp: 994, pulse: 300, spo2: 101, rbs: 45, weight: 400, height: 20 });
    expect(a.blocked).toBe(true);
    expect(a.fields.filter((f) => f.level === "impossible").map((f) => f.field).sort()).toEqual(["height", "pulse", "rbs", "spo2", "temp", "weight"]);
    expect(a.fields.find((f) => f.field === "spo2")!.code).toBe("spo2_over_100");
  });
  it("nothing entered is not a save", () => {
    expect(assessVitals({}).blocked).toBe(true);
    expect(assessVitals({}).empty).toBe(true);
  });
});

describe("vitals: abnormal values warn with text, they do not block", () => {
  it("BP 150/95 is high (H); 185/100 is critical (HH); 85/60 is low (L)", () => {
    expect(lv({ bpSys: 150, bpDia: 95 }, "bp")).toMatchObject({ level: "high", interpretation: "H" });
    expect(lv({ bpSys: 185, bpDia: 100 }, "bp")).toMatchObject({ level: "critical", interpretation: "HH" });
    expect(lv({ bpSys: 130, bpDia: 121 }, "bp")).toMatchObject({ level: "critical" });
    expect(lv({ bpSys: 85, bpDia: 60 }, "bp")).toMatchObject({ level: "low", interpretation: "L" });
    expect(lv({ bpSys: 120, bpDia: 80 }, "bp")).toMatchObject({ level: "normal", interpretation: "N" });
  });
  it("pulse: > 120 critical, > 100 fast, < 50 slow", () => {
    expect(lv({ pulse: 124 }, "pulse")?.level).toBe("critical");
    expect(lv({ pulse: 101 }, "pulse")?.level).toBe("high");
    expect(lv({ pulse: 100 }, "pulse")?.level).toBe("normal");
    expect(lv({ pulse: 48 }, "pulse")?.level).toBe("low");
  });
  it("temperature (°F): ≥ 103 critical, ≥ 100.4 fever, < 95 low", () => {
    expect(lv({ temp: 103 }, "temp")?.level).toBe("critical");
    expect(lv({ temp: 100.4 }, "temp")?.level).toBe("high");
    expect(lv({ temp: 99.4 }, "temp")?.level).toBe("normal");
    expect(lv({ temp: 94 }, "temp")?.level).toBe("low");
  });
  it("SpO₂: < 90 critical (LL), < 95 low", () => {
    expect(lv({ spo2: 88 }, "spo2")).toMatchObject({ level: "critical", interpretation: "LL" });
    expect(lv({ spo2: 94 }, "spo2")?.level).toBe("low");
    expect(lv({ spo2: 98 }, "spo2")?.level).toBe("normal");
  });
  it("RBS (mmol/L): < 2.8 critical, < 3.9 low, random ≥ 11.1 / fasting ≥ 7.0 high", () => {
    expect(lv({ rbs: 2.5 }, "rbs")).toMatchObject({ level: "critical", interpretation: "LL" });
    expect(lv({ rbs: 3.5 }, "rbs")?.level).toBe("low");
    expect(lv({ rbs: 11.2 }, "rbs")?.level).toBe("high");
    expect(lv({ rbs: 7.2, rbsMode: "fasting" }, "rbs")).toMatchObject({ level: "high", code: "rbs_high_fasting" });
    expect(lv({ rbs: 7.2, rbsMode: "random" }, "rbs")?.level).toBe("normal");
  });
  it("the summary counts out-of-range values and flags a critical one", () => {
    const a = assessVitals({ bpSys: 150, bpDia: 95, pulse: 96, temp: 99.4, spo2: 98, rbs: 11.2, weight: 58, height: 152 });
    expect(a.blocked).toBe(false);
    expect(a.outOfRange).toBe(2);
    expect(a.critical).toBe(false);
    expect(assessVitals({ spo2: 85 }).critical).toBe(true);
  });
});

describe("BMI with Asian cut-offs", () => {
  it("58 kg, 152 cm → 25.1, overweight (Asian 23–27.4)", () => {
    expect(bmi(58, 152)).toBe(25.1);
    expect(bmiClass(25.1)).toBe("overweight");
  });
  it("cut-offs 18.5 / 23 / 27.5", () => {
    expect(bmiClass(18.4)).toBe("underweight");
    expect(bmiClass(22.9)).toBe("normal");
    expect(bmiClass(23)).toBe("overweight");
    expect(bmiClass(27.5)).toBe("obese");
  });
  it("no BMI without both weight and height, or when either is impossible", () => {
    expect(assessVitals({ weight: 58 }).bmi).toBeNull();
    expect(assessVitals({ weight: 58, height: 20 }).bmi).toBeNull();
  });
});

describe("parsing typed values", () => {
  it("Bangla digits and a decimal point; empty is null; anything else is not a number", () => {
    expect(parseVital("৯৯.৪")).toBe(99.4);
    expect(parseVital(" 120 ")).toBe(120);
    expect(parseVital("")).toBeNull();
    expect(Number.isNaN(parseVital("12a"))).toBe(true);
  });
  it("a value that is not a number is impossible", () => {
    expect(lv({ pulse: Number.NaN }, "pulse")).toMatchObject({ level: "impossible", code: "not_a_number" });
  });
});

describe("clinical review fixes (02/10/2026)", () => {
  it("systolic and diastolic are flagged separately: 150/80 stores the 80 as normal", () => {
    expect(bpComponents(150, 80)).toEqual({ sys: "H", dia: "N" });
    expect(bpComponents(85, 60)).toEqual({ sys: "L", dia: "N" });
    expect(bpComponents(130, 121)).toEqual({ sys: "N", dia: "HH" });
  });
  it("glucose typed in mg/dL: above 40 is blocked with a unit message; 25–40 needs a re-checked tick", () => {
    expect(lv({ rbs: 180 }, "rbs")).toMatchObject({ level: "impossible", code: "rbs_mgdl" });
    expect(lv({ rbs: 40 }, "rbs")).toMatchObject({ level: "critical", code: "rbs_check_unit", confirm: true });
    expect(assessVitals({ rbs: 30 }).needsConfirm).toEqual(["rbs"]);
    expect(assessVitals({ rbs: 11.2 }).needsConfirm).toEqual([]);
  });
  it("°C in the °F box and feet in the cm box get a unit message", () => {
    expect(lv({ temp: 38.5 }, "temp")?.code).toBe("temp_celsius");
    expect(lv({ height: 5.6 }, "height")?.code).toBe("height_feet");
  });
  it("an implausible BMI (height in inches) blocks on height", () => {
    const a = assessVitals({ weight: 60, height: 66 });
    expect(a.blocked).toBe(true);
    expect(a.bmi).toBeNull();
    expect(lv({ weight: 60, height: 66 }, "height")?.code).toBe("bmi_implausible");
  });
  it("the low end of an impossible range says to tell the doctor if confirmed", () => {
    expect(lv({ bpSys: 35, bpDia: 20 }, "bp")?.code).toBe("bp_impossible_low");
    expect(lv({ pulse: 15 }, "pulse")?.code).toBe("pulse_impossible_low");
  });
});
