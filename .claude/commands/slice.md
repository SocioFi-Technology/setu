Implement journey step **$ARGUMENTS** end to end on the real stack.

Steps, in order — stop after step 1 and show me the plan before writing code:
1. Read `docs/BUILD-PLAN.md` (the step's row), `docs/design-handoff/domain-model.md` (entities + state machines it touches), `docs/design-handoff/shell-roles-plans.md` (who may use the screen), and the prototype page in `docs/prototype/` for that screen. List: entities, routes, state transitions, validation rules, strings, and the walkthrough checks from `docs/test-log/` for this step. Present the plan.
2. Prisma models + migration in `packages/db` and seed rows for the demo tenant.
3. Zod request/response schemas in `packages/contracts`; run `pnpm contracts:gen`.
4. Domain rules and transitions in `packages/domain` with unit tests written first from the walkthrough cases.
5. Route(s) in `apps/api` with tenancy, `authorize`, audit, idempotency.
6. Screen in `apps/staff` (or `apps/patient`) ported from the prototype page, wired to the typed client, every mutation through the offline outbox.
7. Playwright spec `e2e/journeys/<step>.spec.ts` using the same clicks as the walkthrough; run it against the real stack.
8. `pnpm typecheck && pnpm test && pnpm e2e -- --grep <step>`; report what passed and what is left.
