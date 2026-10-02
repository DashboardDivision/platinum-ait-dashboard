# Requirements to tests

| Requirement | Covered by |
|---|---|
| Password-only login, no MFA or verification gate | journey.test.ts (sign-in with starter password, emailVerified stays false) |
| Phone number starter password, U.S. only, forced change, phone reuse rejected | domain.test.ts (phone), journey.test.ts |
| New Twenty record creates one account, replays and races are safe | provisioning.test.ts |
| Existing email is never overwritten; goes to match review | provisioning.test.ts |
| Missing or non-U.S. phone goes to admin fix queue | provisioning.test.ts, backfill.test.ts |
| Pre-launch records only via previewed backfill; quiet welcome option | backfill.test.ts |
| Five stages, completed once, adjacent boundaries share timestamps | domain.test.ts (stages), journey.test.ts |
| Impersonation can't complete stages or count as activity | journey.test.ts |
| Stage 4 approval: one task, one reimbursement, required admin email | journey.test.ts |
| Premium rule: new business after contract, Denver days, net of cancellations | domain.test.ts (premium), journey.test.ts |
| Milestones $25k–$250k, graduation completes Stage 5, below-threshold flag | domain.test.ts, journey.test.ts |
| Reimbursement payments: no duplicates or overpayment | journey.test.ts |
| Message delivery: per-recipient dedupe, retry without re-send, quiet hours | outbox.test.ts |
| CSV export formula injection guard | domain.test.ts (csv) |
| Calendar dates shown without time-zone shift | domain.test.ts (formatDay) |

39 tests pass (`npm test`, needs a local Postgres). Screens were checked at 1366 px and 390 px widths against demo data.
