import type { ApiError } from "@setu/contracts";
export class HttpError extends Error {
  constructor(public status: number, public body: ApiError) { super(body.message_en); }
}
export const err = (status: number, code: string, message_bn: string, message_en: string, extra: Partial<ApiError> = {}) =>
  new HttpError(status, { code, message_bn, message_en, ...extra });
export const unauthorized = () => err(401, "unauthorized", "লগইন করুন", "Please sign in");
export const forbidden = (reason: "role" | "plan" | "unknown") =>
  err(403, "forbidden", reason === "plan" ? "এই প্ল্যানে নেই" : "প্রবেশাধিকার নেই", reason === "plan" ? "Not in your plan" : "No access", { reason, canRequest: reason === "role" });
