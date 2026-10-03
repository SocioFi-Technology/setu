-- Admin (ADR 0010): the price list is edited by owner / admin through the app (never deleted — switched off instead);
-- facilities, users, roles, registrations and locations are never deleted by the app (users are switched off).
GRANT INSERT, UPDATE ON "ChargeItemDefinition" TO setu_app;
REVOKE DELETE ON "ChargeItemDefinition", "Organization", "User", "PractitionerRole", "Practitioner", "Location" FROM setu_app;
