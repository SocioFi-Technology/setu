-- ADR 0022 (Journey E1–E2): the portable lab order — the doctor orders tests the patient may have done at any network
-- centre; the patient (or the desk for them) picks a centre; the centre accepts all, part or none.

-- an order the ordering facility's own lab and bill never take
ALTER TABLE "ServiceRequest" ADD COLUMN "performer" TEXT NOT NULL DEFAULT 'in-house';
ALTER TABLE "ServiceRequest" ADD CONSTRAINT service_request_performer CHECK ("performer" IN ('in-house', 'network'));

-- the centre's network offer: a test offered to the network (its own price), home collection, turnaround
ALTER TABLE "ChargeItemDefinition" ADD COLUMN "network" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN "homeCollection" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN "homeCollectionFeePaisa" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD COLUMN "networkTurnaroundHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "Organization" ADD CONSTRAINT organization_network_offer CHECK ("homeCollectionFeePaisa" >= 0 AND "networkTurnaroundHours" BETWEEN 1 AND 720);
-- a centre's patient record made from a network order: the order's number (name, sex, age and phone only)
ALTER TABLE "Patient" ADD COLUMN "networkOrigin" TEXT;

CREATE SEQUENCE portable_order_seq;

CREATE TABLE "PortableOrder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL,
  "originTenantId" TEXT NOT NULL,
  "originOrganizationId" TEXT NOT NULL,
  "originPatientId" TEXT NOT NULL,
  "originEncounterId" TEXT NOT NULL,
  "orderedById" TEXT NOT NULL,
  -- names as they were (no cross-tenant read to show them)
  "originFacilityEn" TEXT NOT NULL,
  "originFacilityBn" TEXT,
  "doctorEn" TEXT NOT NULL,
  "doctorBn" TEXT NOT NULL,
  -- what the chosen centre gets about the patient: name, sex, age, phone — nothing else
  "patientNameEn" TEXT,
  "patientNameBn" TEXT NOT NULL,
  "patientSex" TEXT NOT NULL,
  "patientAgeYears" INTEGER,
  "patientPhone" TEXT,
  "status" "OrderStatus" NOT NULL DEFAULT 'active',
  "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "centreTenantId" TEXT,
  "centreOrganizationId" TEXT,
  "centreFacilityEn" TEXT,
  "centreFacilityBn" TEXT,
  -- centre | home
  "collection" TEXT,
  "chosenAt" TIMESTAMP(3),
  -- patient (in the app) | desk (the ordering facility's front desk, for the patient)
  "chosenByKind" TEXT,
  "chosenBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decidedById" TEXT,
  "decidedByName" TEXT,
  "centrePatientId" TEXT,
  "centreEncounterId" TEXT,
  -- a re-order of an earlier order's declined tests
  "reorderOfId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortableOrder_origin_patient_fkey" FOREIGN KEY ("originTenantId", "originPatientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "PortableOrder_origin_org_fkey" FOREIGN KEY ("originTenantId", "originOrganizationId") REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "PortableOrder_centre_org_fkey" FOREIGN KEY ("centreTenantId", "centreOrganizationId") REFERENCES "Organization"("tenantId", "id") ON DELETE RESTRICT,
  CONSTRAINT "PortableOrder_reorder_fkey" FOREIGN KEY ("reorderOfId") REFERENCES "PortableOrder"("id") ON DELETE RESTRICT,
  CONSTRAINT portable_status CHECK ("status" IN ('active', 'centre-chosen', 'accepted', 'partially-accepted', 'declined', 'revoked')),
  -- a centre is named exactly when one was chosen; decided exactly when past centre-chosen
  CONSTRAINT portable_chosen CHECK (("status" = 'active') = ("centreTenantId" IS NULL)
    AND (("centreTenantId" IS NULL) = ("chosenAt" IS NULL)) AND (("centreTenantId" IS NULL) = ("chosenByKind" IS NULL))
    AND ("chosenByKind" IS NULL OR "chosenByKind" IN ('patient', 'desk')) AND ("collection" IS NULL OR "collection" IN ('centre', 'home'))),
  CONSTRAINT portable_decided CHECK (("status" IN ('accepted', 'partially-accepted', 'declined')) = ("decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL))
);
CREATE UNIQUE INDEX "PortableOrder_number_key" ON "PortableOrder"("number");
CREATE INDEX "PortableOrder_origin_idx" ON "PortableOrder"("originTenantId", "originPatientId", "createdAt");
CREATE INDEX "PortableOrder_centre_idx" ON "PortableOrder"("centreTenantId", "centreOrganizationId", "status");

CREATE TABLE "PortableOrderItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "originServiceRequestId" TEXT NOT NULL,
  "testCode" TEXT NOT NULL,
  "nameEn" TEXT NOT NULL,
  "nameBn" TEXT NOT NULL,
  -- pending | accepted | declined
  "status" TEXT NOT NULL DEFAULT 'pending',
  "declineReason" TEXT,
  "notOffered" BOOLEAN NOT NULL DEFAULT false,
  -- the chosen centre's price when it was chosen (paisa)
  "unitPaisa" INTEGER,
  "centreServiceRequestId" TEXT,
  "reorderedToId" TEXT,
  CONSTRAINT "PortableOrderItem_order_fkey" FOREIGN KEY ("orderId") REFERENCES "PortableOrder"("id") ON DELETE RESTRICT,
  CONSTRAINT "PortableOrderItem_reorder_fkey" FOREIGN KEY ("reorderedToId") REFERENCES "PortableOrder"("id") ON DELETE RESTRICT,
  CONSTRAINT portable_item_status CHECK ("status" IN ('pending', 'accepted', 'declined')),
  CONSTRAINT portable_item_decline CHECK (("status" = 'declined') = ("declineReason" IS NOT NULL OR "notOffered")
    AND ("declineReason" IS NULL OR length(btrim("declineReason")) >= 10) AND ("notOffered" = false OR "status" = 'declined')),
  CONSTRAINT portable_item_centre_order CHECK (("status" = 'accepted') = ("centreServiceRequestId" IS NOT NULL)),
  CONSTRAINT portable_item_reorder CHECK ("reorderedToId" IS NULL OR "status" = 'declined')
);
CREATE INDEX "PortableOrderItem_order_idx" ON "PortableOrderItem"("orderId");
CREATE INDEX "PortableOrderItem_origin_sr_idx" ON "PortableOrderItem"("originServiceRequestId");

-- once fixed, never changed: who ordered what for whom; the choice once made; the decision once made
CREATE OR REPLACE FUNCTION portable_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PortableOrder: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."centreTenantId" IS NOT NULL THEN RAISE EXCEPTION 'PortableOrder: a new order waits for a centre'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."number", NEW."originTenantId", NEW."originOrganizationId", NEW."originPatientId", NEW."originEncounterId", NEW."orderedById", NEW."reorderOfId", NEW."createdAt",
      NEW."patientNameBn", NEW."patientNameEn", NEW."patientSex", NEW."patientAgeYears", NEW."patientPhone")
     IS DISTINCT FROM (OLD."number", OLD."originTenantId", OLD."originOrganizationId", OLD."originPatientId", OLD."originEncounterId", OLD."orderedById", OLD."reorderOfId", OLD."createdAt",
      OLD."patientNameBn", OLD."patientNameEn", OLD."patientSex", OLD."patientAgeYears", OLD."patientPhone") THEN
    RAISE EXCEPTION 'PortableOrder %: who ordered what for whom never changes', OLD."id";
  END IF;
  IF (OLD."status"::text || '>' || NEW."status"::text) NOT IN ('active>centre-chosen', 'centre-chosen>accepted', 'centre-chosen>partially-accepted', 'centre-chosen>declined',
      'active>revoked', 'centre-chosen>revoked', 'accepted>accepted', 'partially-accepted>partially-accepted', 'declined>declined') THEN
    RAISE EXCEPTION 'PortableOrder %: ORDER cannot go from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  IF OLD."centreTenantId" IS NOT NULL AND (NEW."centreTenantId", NEW."centreOrganizationId", NEW."collection", NEW."chosenAt", NEW."chosenByKind", NEW."chosenBy")
     IS DISTINCT FROM (OLD."centreTenantId", OLD."centreOrganizationId", OLD."collection", OLD."chosenAt", OLD."chosenByKind", OLD."chosenBy") THEN
    RAISE EXCEPTION 'PortableOrder %: the chosen centre never changes (re-order elsewhere instead)', OLD."id";
  END IF;
  IF OLD."decidedAt" IS NOT NULL AND (NEW."decidedAt", NEW."decidedById", NEW."centrePatientId", NEW."centreEncounterId")
     IS DISTINCT FROM (OLD."decidedAt", OLD."decidedById", OLD."centrePatientId", OLD."centreEncounterId") THEN
    RAISE EXCEPTION 'PortableOrder %: the centre''s decision never changes', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portable_order_guard BEFORE INSERT OR UPDATE OR DELETE ON "PortableOrder" FOR EACH ROW EXECUTE FUNCTION portable_order_guard();

CREATE OR REPLACE FUNCTION portable_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PortableOrderItem: never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' OR NEW."reorderedToId" IS NOT NULL OR NEW."centreServiceRequestId" IS NOT NULL THEN RAISE EXCEPTION 'PortableOrderItem: a new item waits for the centre'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW."orderId", NEW."originServiceRequestId", NEW."testCode", NEW."nameEn", NEW."nameBn") IS DISTINCT FROM (OLD."orderId", OLD."originServiceRequestId", OLD."testCode", OLD."nameEn", OLD."nameBn") THEN
    RAISE EXCEPTION 'PortableOrderItem %: the test never changes', OLD."id";
  END IF;
  IF OLD."status" <> 'pending' AND (NEW."status", NEW."declineReason", NEW."notOffered", NEW."centreServiceRequestId") IS DISTINCT FROM (OLD."status", OLD."declineReason", OLD."notOffered", OLD."centreServiceRequestId") THEN
    RAISE EXCEPTION 'PortableOrderItem %: the centre''s decision never changes', OLD."id";
  END IF;
  IF OLD."reorderedToId" IS NOT NULL AND NEW."reorderedToId" IS DISTINCT FROM OLD."reorderedToId" THEN RAISE EXCEPTION 'PortableOrderItem %: re-ordered once', OLD."id"; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portable_item_guard BEFORE INSERT OR UPDATE OR DELETE ON "PortableOrderItem" FOR EACH ROW EXECUTE FUNCTION portable_item_guard();

-- a person's linked record (the claim) — for the patient's read policy; ids only (SECURITY DEFINER: claims are per tenant)
CREATE OR REPLACE FUNCTION person_has_record(p_person text, p_tenant text, p_patient text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_person IS NOT NULL AND p_person <> '' AND EXISTS (SELECT 1 FROM "PatientClaim" c WHERE c."personId" = p_person AND c."tenantId" = p_tenant AND c."patientId" = p_patient AND c."status" = 'linked');
$$;
REVOKE ALL ON FUNCTION person_has_record(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_has_record(text, text, text) TO setu_app;

-- row-level security: the ordering tenant reads and writes; the chosen centre's tenant reads and records its decision;
-- the patient reads their own (a linked claim on the ordering record)
ALTER TABLE "PortableOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PortableOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY origin_rw ON "PortableOrder" USING ("originTenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("originTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY centre_read ON "PortableOrder" FOR SELECT USING ("centreTenantId" IS NOT NULL AND "centreTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY centre_decide ON "PortableOrder" FOR UPDATE USING ("centreTenantId" IS NOT NULL AND "centreTenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("centreTenantId" = current_setting('app.tenant_id', true));
CREATE POLICY person_read ON "PortableOrder" FOR SELECT USING (person_has_record(current_setting('app.person_id', true), "originTenantId", "originPatientId"));
ALTER TABLE "PortableOrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PortableOrderItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY via_order ON "PortableOrderItem" USING (EXISTS (SELECT 1 FROM "PortableOrder" o WHERE o."id" = "orderId")) WITH CHECK (EXISTS (SELECT 1 FROM "PortableOrder" o WHERE o."id" = "orderId"));

-- the network centres a patient can choose from: live, joined facilities, their area, turnaround, home collection and the
-- tests they offer to the network at their prices — nothing else (SECURITY DEFINER: each facility's own price list)
CREATE OR REPLACE FUNCTION network_centres() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'tenantId', o."tenantId", 'organizationId', o."id", 'nameEn', o."name", 'nameBn', o."nameBn", 'area', o."address",
    'homeCollection', o."homeCollection", 'homeCollectionFeePaisa', o."homeCollectionFeePaisa", 'turnaroundHours', o."networkTurnaroundHours",
    'tests', coalesce((SELECT jsonb_agg(jsonb_build_object('testCode', d."refCode", 'unitPaisa', d."unitPaisa") ORDER BY d."refCode")
      FROM "ChargeItemDefinition" d WHERE d."tenantId" = o."tenantId" AND d."organizationId" = o."id" AND d."kind" = 'test' AND d."network" AND d."active" AND d."refCode" IS NOT NULL), '[]'::jsonb)
  ) ORDER BY o."name"), '[]'::jsonb)
  FROM "Organization" o WHERE o."networkJoinedAt" IS NOT NULL AND o."status" = 'live';
$$;
REVOKE ALL ON FUNCTION network_centres() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network_centres() TO setu_app;
