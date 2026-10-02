# Architecture

**Stack:** Next.js 16 (App Router, server actions), Better Auth 1.7 (email + password only), Drizzle ORM on its own Postgres 17, n8n for orchestration, Twenty as the CRM. All on Colton's VPS.

**Why this stack:** one TypeScript codebase, no paid services, and a mature auth library that supports password-only sign-in, disabled public sign-up, admin impersonation and database-backed rate limits. A self-hosted LMS or Supabase was considered and rejected as heavier than the requirements and harder to run on a server with ~5 GB free RAM.

## Flow
1. A `platinumAit` record is created in Twenty's Life CRM.
2. Twenty's signed webhook hits n8n. n8n checks the signature, re-reads the record from Twenty's API, and posts it to `/api/integrations/twenty/recruit`. A 15-minute catch-up poll covers missed webhooks.
3. The app creates the recruit, a dashboard login (email + U.S. phone number as starter password, forced change) and opens Stage 1, all in one transaction. Events are deduped; accounts are matched by CRM record id, never by email alone.
4. State changes write to an outbox in the same transaction. n8n claims rendered messages every minute, sends them through Gmail (and Telnyx when texts are enabled), and reports each delivery back. Recipients already sent are never sent again.
5. Momentum AMP policies arrive through `/api/integrations/momentum/policies`; production, milestones and graduation ($250,000 annualized) are recomputed on every change.

## Boundaries
- The education site is not modified (Colton's decision). Its account status shows "Unavailable" and study time "not available".
- Password-reset emails are sent by the app directly, so reset links never enter n8n.
- Uploaded documents live in a private volume and are only served through an authorization check with `nosniff` and a sandbox CSP.
- n8n workflows that touch personal data keep no execution history.

## Ownership
| Piece | Owner | Where |
|---|---|---|
| App and database | Platinum (Colton) | /opt/ait on the VPS |
| Source code | DashboardDivision/platinum-ait-dashboard | GitHub |
| Workflows | n8n.getstrategic.vip | names start "Platinum AIT -" |
| Recruit records | Twenty "Life CRM" | `platinumAit` object |
