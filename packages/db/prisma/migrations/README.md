The init migration must also carry `../rls.sql` (row-level security and the append-only audit table), so both
are created in the same step. Create the migration without applying it, append, then apply:

```sh
pnpm db:migrate --name init --create-only
cat packages/db/prisma/rls.sql >> packages/db/prisma/migrations/<timestamp>_init/migration.sql
pnpm db:migrate
```

Don't apply the migration first and append afterwards: Prisma sees the edited migration's checksum change and
refuses to continue until the database is reset (`prisma migrate reset`), which drops all data.

Only migration folders belong in this directory. Every subfolder must contain a `migration.sql` or Prisma fails with P3015.

**Since 03/10/2026 `prisma migrate dev` refuses on the dev database** ("`20261002215727_billing_followups` was modified
after it was applied"): the first, rolled-back attempt of that migration is still in `_prisma_migrations` with an older
checksum, while the applied one matches the file. Never reset to get past it. Write new migrations by hand instead:

```sh
cd packages/db
npx dotenv -e ../../.env -- prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > /tmp/m.sql
# new folder prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql = /tmp/m.sql + the guard SQL
pnpm --filter @setu/db migrate:deploy && pnpm --filter @setu/db generate
```
A value added to an enum must be committed before a constraint, index or trigger body that runs uses it: put such
guards in a second migration (`lab` + `lab_guards`).
