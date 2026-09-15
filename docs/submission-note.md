# Submission note (under 300 words; Google access pending)

I built the portal with React/TypeScript and Supabase Auth/Postgres. Ordinary portal reads use the public key plus the signed-in user’s JWT. Privileged keys stay on the server.

I tested direct cross-tenant reads, analyst writes, forged approvals, repeated and concurrent confirmation, changed consent, worker crash recovery, duplicate/out-of-order events, unrelated recipients, and report-session scope. The Postgres regression explicitly disables RLS and proves the isolation assertion fails. The tenant-read policies are generated at `schema.sql:680`; tenant and membership policies follow at lines 691 and 700.

Live checks passed for six password accounts, Google sign-in to the same Kilele owner identity, concurrent confirmation returning one job, a 327-recipient synthetic campaign, password-gated aggregate reports, and a scheduled production worker invocation. The provider accepted 327 recipients; later reports recorded 309 deliveries and 18 bounces. Twenty-three automated tests, type checking, and lint passed.

My least certain metric is historical unique engagement. MAR-0006 reports 129 opens and 186 clicks in its export, but the imported event log supports only 14 unique opens and 5 unique clicks. The portal exposes both sources and their different coverage instead of inventing reconciliation.

Provider timeout/partial-acceptance guarantees were not independently proven live; defensive recovery is covered by automated tests. An unlisted Google identity was not exercised live; signups are disabled and database denial is tested.

Google access for the other five users remains pending; I have asked the recruiter for Google accounts and am awaiting a reply. All six password accounts work.

AI assistance: Codex. Development began 13 September 2026.
