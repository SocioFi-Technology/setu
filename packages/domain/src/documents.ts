/* Clinical document signing (ADR 0003). The DOCUMENT table allows `signAmendment` from any draft; the rule that only a
   draft amending another version may use it — and that such a draft may not use plain `sign` — lives here, in the
   domain, so every caller (routes and screens) goes through the same guard (clinical review 02/10/2026). */
import { DOCUMENT, TransitionError, transition, type DocState } from "./machines.js";

export interface SignableDoc { status: DocState; amendsId: string | null; amendReason?: string | null }
export const AMEND_REASON_MIN = 5; // prototype: "Reason is required, minimum 5 characters"

/** The state a draft moves to when signed: `final` for a first version, `amended` for an amendment (which needs a reason). */
export function signDocument(doc: SignableDoc): DocState {
  if (doc.amendsId) {
    if ((doc.amendReason ?? "").trim().length < AMEND_REASON_MIN) throw new TransitionError("document", doc.status, "signAmendment");
    return transition("document", DOCUMENT, doc.status, "signAmendment");
  }
  return transition("document", DOCUMENT, doc.status, "sign");
}
