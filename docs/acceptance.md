# Live acceptance checklist

Do not mark a check complete without observing the result. Automated local tests do not replace these checks.

## Access and isolation

- Sign in using all six email/password accounts. Verify the correct brand and role.
- Sign in with the demonstration Google email. Verify the same user ID, tenant, and role as password login.
- Attempt an unlisted Google identity and a direct Supabase signup. Neither must gain data access.
- For each user, use the public key and their JWT to read contacts, campaigns, events, imports, approvals, and worker records directly through Supabase REST. Cross-tenant rows must be absent.
- Attempt direct role modification, contact writes, cross-tenant foreign keys, worker RPCs, and report-secret reads using owner, analyst, and anonymous credentials.
- Check RLS and grants on every table, plus the default privileges for new tables/functions.

## Import and metrics

- Import all supplied files and inspect completed/failed runs and row diagnostics.
- Reimport every file and compare contact/event counts. Reapply an old baseline after the delta and confirm newer contact values remain.
- Compare total customers, channel eligibility, and signup-day counts to independent SQL. Confirm timezone and unknown-date labels are visible.
- Compare historical reported totals, deduplicated send-log counts, unique opens/clicks, and event coverage. Do not pretend disagreeing sources are reconciled.
- Test pagination/search on the large brand, including its final page.

## Sending and recovery

- Preview a campaign and inspect its exact recipient list and count, including the final page.
- Change consent after preview and before confirmation. It must block without creating a send.
- Confirm the same preview from two independent sessions at once. Inspect the database and provider record for one send.
- Create two different previews of one campaign and confirm concurrently. Only one job may win.
- Interrupt the worker after provider acceptance but before saving the response, then restart. Verify the original key/payload is retried without duplicate delivery.
- Change consent before a later batch's first attempt. Remaining unsent work must stop visibly.
- Test rejected, partial, malformed, throttled, and ambiguous provider outcomes. The UI must preserve honest status.
- Close all app tabs and verify Cron continues polling. Check actual HTTP results, not only Cron's own successful scheduling status.
- Replay duplicate/out-of-order events; try an unrelated recipient and an inconsistent batch ID. Suppression must not regress and foreign events must be quarantined.

## Shared link and runtime

- Publish a campaign report, open it without a portal session, and check the password gate.
- Try wrong passwords, guessed tokens, a session from another report, expired sessions, and revoked links.
- Inspect the returned payload: only the chosen campaign's aggregate projection should be present.
- Verify no service key, provider key, credentials, or report password appears in browser bundles or the public repository.
- Exercise loading, empty, denied, and failed states at phone and laptop widths, including keyboard focus and modal dismissal.
- Run a request against the production Worker, and verify an authenticated database query and a provider event page there.

## Observed live results — 14 September 2026 (UTC)

- All six password accounts authenticated against hosted Supabase. Direct public-key/JWT queries returned no foreign-tenant contacts; report-secret and worker access were denied. Analyst preview creation was denied.
- Google sign-in completed in the public portal as the Kilele owner. The existing password user has both email and Google identities; the dashboard showed 82,107 customers and 36,177 contactable customers.
- All eleven supplied files completed import. Final customer counts: Kilele 82,107, Karoo 12,406, Marrakech 918. Historical event counts: 303,588, 69,100, and 307 respectively. The independent full-seed Postgres verification matched these counts.
- Two concurrent authenticated confirmations returned the same Marrakech MAR-0006 send job. Its 327 supplied synthetic email destinations were accepted in 14 batches. After later polling: 309 delivered, 18 bounced, 100 opened, 14 unsubscribed; no remaining polling errors. Unrelated recipient reports were quarantined.
- Report route integration verified the password gate, wrong-password denial, aggregate-only output, report-specific cookies, cross-report denial, and revocation. The deployed public endpoint separately passed unauthorized, password unlock, and aggregate reads.
- The deployed worker endpoint returned HTTP 200. Supabase Cron is active every minute; `net._http_response` recorded HTTP 200, no timeout, and `{ "dispatched": 0, "pages": 10 }` at 21:45 UTC, proving a scheduled HTTP invocation reached the live application.
- Type checking, lint, and all 23 tests passed. The eligibility performance migration preserves RLS and matches the original channel decisions in the regression suite.

The checklist above remains a reusable acceptance plan, not a claim that every adversarial scenario was reproduced on the live provider. Crash recovery, stale consent, malformed acknowledgements, and RLS-off regression are automated Postgres/domain tests. Live provider timeout/partial-acceptance guarantees and an unlisted Google login were not independently exercised. Signups are disabled and unlisted identity access is covered by database tests.


## Final verification — 15 September 2026

No emails or campaigns were sent during this verification. Google account changes remain excluded pending the recruiter's reply.

- All 31 automated tests passed, including six real-worker simulations using a local database and a provider stub: timeout after acceptance, crash before saving the response, throttling, partial acceptance, malformed acknowledgement, and permanent rejection. Retry cases preserve the original payload and idempotency key. These establish application recovery behavior, not the external provider's delivery guarantee.
- Two independent PostgreSQL sessions raced both the same approval and different approvals for one campaign. The test observed the second transaction waiting on a database lock; only one send job survived each race. Run `node scripts/verify-concurrency.mjs` with the optional embedded PostgreSQL runtime below.
- All eleven supplied files were imported and replayed through the real SQL importer in native PostgreSQL. Complete contact, campaign, event, and historical-send fingerprints remained identical, including replay of the old contact baseline after the delta. Private evidence: `work/seed-verification.json`.
- Report route tests cover expired sessions, rate limiting, successful access after the rate window, and revocation. Existing tests cover cross-report scope and aggregate-only access.
- Dashboard boundary tests cover all three tenant timezones, both edges of the 30-day window, unknown dates, deleted contacts, and an out-of-range contact page.
- All six hosted password accounts passed direct cross-tenant checks across 14 tenant tables, dashboard reads, first/final contact pages, and empty searches. Kilele's final page returned seven records at page index 1642. Private evidence: `work/final-live-readonly.json`. Its legacy `lastPageMs` measurement includes the subsequent empty search; the script now names this measurement accurately.
- The large-brand final-page check exposed a timeout. Migration 008 now limits the page before computing contact eligibility. Migration 009 disables dashboard JIT compilation overhead. Both were applied to hosted Supabase; tenant policies and query results remain unchanged.
- Browser checks covered analyst navigation, loading and empty contact states, mobile sidebar dismissal, historical campaign results, and import history. A mobile tab orientation bug was fixed and visually checked at 390 × 844.

### Reproduce optional native database checks

Install the isolated runtime outside the repository:

```sh
npm install --prefix /tmp/velocity-postgres-test embedded-postgres@18.4.0-beta.17 pg
node scripts/verify-concurrency.mjs
TEST_NATIVE_PG=1 npm run verify:seed
```

The scripts create temporary local databases and never invoke the live messaging provider. The full replay can take several minutes. Default `npm run verify:seed` uses PGlite and is slower. Tests are simulations plus the explicitly listed live checks; they do not claim every failure was reproduced against the live provider.
