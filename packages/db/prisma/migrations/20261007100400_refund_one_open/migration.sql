-- Review (B10–B12): one open refund per bill — the excess deposit's refund of an IPD final bill runs beside it (a line
-- refunded after the bill was issued must not wait for the excess to be paid back).
DROP INDEX "Refund_one_open_per_bill";
CREATE UNIQUE INDEX "Refund_one_open_per_bill" ON "Refund" ("invoiceId") WHERE "status" IN ('requested', 'approved') AND "source" <> 'deposit-excess';
CREATE UNIQUE INDEX "Refund_one_open_excess_per_bill" ON "Refund" ("invoiceId") WHERE "status" IN ('requested', 'approved') AND "source" = 'deposit-excess';
