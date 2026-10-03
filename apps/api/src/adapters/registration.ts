/* Registration checks (ADR 0010): a doctor's BMDC or a nurse's BNMC number is verified before go-live and before the
   doctor signs. Behind an interface (CLAUDE.md adapters); the Fake answers from the number's shape until a real lookup
   is available: "A-12345"-style numbers (a letter, a dash, 4–6 digits) are found, unless they end in 000 (not found). */
export interface RegistrationVerifier {
  readonly name: string;
  verify(body: "BMDC" | "BNMC", regNo: string): Promise<{ status: "verified" | "not-found"; checkedAt: string }>;
}
export class FakeRegistrationVerifier implements RegistrationVerifier {
  readonly name = "fake";
  async verify(_body: "BMDC" | "BNMC", regNo: string) {
    const n = regNo.trim().toUpperCase();
    const ok = /^[A-Z]-?\d{4,6}$/.test(n) && !n.endsWith("000");
    return { status: ok ? ("verified" as const) : ("not-found" as const), checkedAt: new Date().toISOString() };
  }
}
export const registration: RegistrationVerifier = new FakeRegistrationVerifier();
