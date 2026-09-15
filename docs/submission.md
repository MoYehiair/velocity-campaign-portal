# Submission preparation

Submission deadline: 16 September 2026, 23:59 Africa/Cairo.

Provide these privately to Velocity Growth after live acceptance:

- Public application URL.
- Six email/password logins, one owner and analyst per brand.
- Confirmation of demonstrated Google sign-in and the identity used.
- Supabase project URL and public anon key.
- `schema.sql` and the table/function map in `docs/architecture.md`.
- Explanation that ordinary portal queries use the public key plus the user's JWT; privileged credentials are restricted to server administration, the worker, and narrow sharing operations.
- Public GitHub repository with actual development history and README.
- AI tools used (Codex), actual elapsed effort, earliest start date, and notice period.
- Send progress: `send_approvals`, `approval_recipients`, `send_jobs`, `send_batches`, `provider_events`, and `provider_issues`.
- The issued provider key, shared privately; never committed.
- A working shared report URL and its password.

## Final note, at most 300 words

Draft only after the live checks. Include:

1. What was deliberately attacked: direct cross-tenant Supabase reads, analyst writes, repeated/concurrent confirmations, stale consent, interrupted dispatch, malformed/duplicate/foreign events, and report-session scope.
2. The exact reviewed file and line containing the RLS policies. Resolve current line numbers after the final formatting/commit.
3. The least certain number: historical unique engagement compared with exported delivery totals, because the event log and export claims do not establish the same denominator. State the specific observed discrepancy.
4. Anything unfinished or not independently verified. Do not say Google, Cron, deployment, or live concurrency works until observed.

Do not attach private .env files, service keys, OAuth secrets, or a credentials JSON file to the public repository.

## Handoff preparation — 15 September 2026

- Private email draft assembled in ignored `secrets/submission-email-draft.md`; no email sent.
- Public repository is reachable, contains README.md and schema.sql, and matched local commit `49dcaad` at verification time.
- Live app and report page returned HTTP 200. All six password logins returned their expected brand and role through the deployed membership endpoint.
- Existing report rejected missing/wrong passwords with HTTP 401 and returned campaign aggregates after correct-password authentication. The report session cookie included HttpOnly and Secure.
- Google access for five users remains pending the recruiter’s reply; Kilele owner Google sign-in was previously demonstrated.
- Remaining applicant input: actual hands-on hours, earliest employment start date, and notice period.
- No campaigns were sent during this handoff check. No new full browser or campaign-send test was performed.
