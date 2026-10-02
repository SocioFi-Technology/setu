-- The receipts migration dropped the GIN index made by billing_guards (Prisma did not know it); it is now declared in
-- schema.prisma (@@index([supersededRefs], type: Gin)) so later migrations keep it.
-- CreateIndex
CREATE INDEX "Payment_supersededRefs_idx" ON "Payment" USING GIN ("supersededRefs");
