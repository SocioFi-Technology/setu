-- The lab worklist picks a branch's most recent lab visits (external review / staging load check, 09/10/2026): it fetched
-- every lab order of 30 days to do so; now the database groups them, on this index. Additive.
CREATE INDEX "ServiceRequest_tenantId_branchId_group_orderedAt_idx" ON "ServiceRequest"("tenantId", "branchId", "group", "orderedAt");
