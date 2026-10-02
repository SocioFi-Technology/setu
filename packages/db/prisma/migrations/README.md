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
