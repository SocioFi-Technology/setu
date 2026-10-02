Review the current working tree before I commit.

1. Run `pnpm typecheck`, `pnpm test`, and the e2e specs for any journey step touched. Fix only what is broken by this change.
2. Check every changed file against `CLAUDE.md`: tenancy on new tables, idempotency on new write routes, audit on PHI reads, money in paisa, strings through i18n, state changes through `@setu/domain`.
3. List any TODOs or hardcoded sample data left behind.
4. Write a commit message: one line summary, then "Changed:" and "Tested:" sections. Do not commit; show it to me.
