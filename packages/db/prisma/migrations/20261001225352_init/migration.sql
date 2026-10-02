-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('clinic', 'lite', 'pro');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('receptionist', 'doctor', 'nurse', 'labTech', 'pathologist', 'pharmacist', 'cashier', 'owner', 'admin');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('branch', 'department', 'ward', 'room', 'bed');

-- CreateEnum
CREATE TYPE "BedState" AS ENUM ('vacant', 'reserved', 'occupied', 'discharge_pending', 'cleaning', 'blocked');

-- CreateEnum
CREATE TYPE "IdentityConfidence" AS ENUM ('verified', 'unverified', 'possible_duplicate', 'provisional');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('male', 'female', 'other');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'clinic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameBn" TEXT,
    "licenceNo" TEXT,
    "address" TEXT,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" "LocationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "nameBn" TEXT,
    "bedClass" TEXT,
    "bedState" "BedState",

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "nameBn" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "pinHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PractitionerRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "PractitionerRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Practitioner" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "regBody" TEXT,
    "regNo" TEXT,
    "regVerified" BOOLEAN NOT NULL DEFAULT false,
    "degrees" TEXT,
    "speciality" TEXT,

    CONSTRAINT "Practitioner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT,
    "pushToken" TEXT,
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "facilityNo" TEXT NOT NULL,
    "setuId" TEXT,
    "nid" TEXT,
    "birthRegNo" TEXT,
    "nameBn" TEXT NOT NULL,
    "nameEn" TEXT,
    "sex" "Sex" NOT NULL,
    "birthDate" TIMESTAMP(3),
    "approxAgeYears" INTEGER,
    "phone" TEXT,
    "phoneOwner" TEXT,
    "division" TEXT,
    "district" TEXT,
    "upazila" TEXT,
    "addressLine" TEXT,
    "photoKey" TEXT,
    "identityConfidence" "IdentityConfidence" NOT NULL DEFAULT 'unverified',
    "identityMethod" TEXT,
    "linkedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelatedPerson" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "nameBn" TEXT NOT NULL,
    "phone" TEXT,
    "guardianProof" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RelatedPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "role" "Role",
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "patientId" TEXT,
    "deviceId" TEXT,
    "ip" TEXT,
    "basis" TEXT,
    "detail" JSONB,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("tenantId","name")
);

-- CreateIndex
CREATE INDEX "Organization_tenantId_idx" ON "Organization"("tenantId");

-- CreateIndex
CREATE INDEX "Location_tenantId_organizationId_idx" ON "Location"("tenantId", "organizationId");

-- CreateIndex
CREATE INDEX "Location_parentId_idx" ON "Location"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_phone_key" ON "User"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "PractitionerRole_tenantId_idx" ON "PractitionerRole"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PractitionerRole_userId_organizationId_role_key" ON "PractitionerRole"("userId", "organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_userId_key" ON "Practitioner"("userId");

-- CreateIndex
CREATE INDEX "Practitioner_tenantId_idx" ON "Practitioner"("tenantId");

-- CreateIndex
CREATE INDEX "Session_tenantId_userId_idx" ON "Session"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Device_tenantId_idx" ON "Device"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_setuId_key" ON "Patient"("setuId");

-- CreateIndex
CREATE INDEX "Patient_tenantId_phone_idx" ON "Patient"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "Patient_tenantId_nameBn_idx" ON "Patient"("tenantId", "nameBn");

-- CreateIndex
CREATE INDEX "Patient_tenantId_nameEn_idx" ON "Patient"("tenantId", "nameEn");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_tenantId_facilityNo_key" ON "Patient"("tenantId", "facilityNo");

-- CreateIndex
CREATE INDEX "RelatedPerson_tenantId_patientId_idx" ON "RelatedPerson"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_patientId_at_idx" ON "AuditEvent"("tenantId", "patientId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_at_idx" ON "AuditEvent"("tenantId", "at");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_tenantId_key_route_key" ON "IdempotencyKey"("tenantId", "key", "route");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerRole" ADD CONSTRAINT "PractitionerRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PractitionerRole" ADD CONSTRAINT "PractitionerRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Practitioner" ADD CONSTRAINT "Practitioner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedPerson" ADD CONSTRAINT "RelatedPerson_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security keyed by the session variable app.tenant_id (set by @setu/db forTenant()).
-- Apply to every table that has tenantId. The API's DB role must NOT be the table owner or superuser.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE column_name = 'tenantId' AND table_schema = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;

-- Rule 5: the audit log is append-only.
CREATE OR REPLACE FUNCTION audit_no_change() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'AuditEvent is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_append_only ON "AuditEvent";
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION audit_no_change();
