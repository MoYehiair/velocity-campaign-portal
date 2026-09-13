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

## Known setup dependencies

Hosted Supabase credentials, the user's real Google identity and OAuth client, production environment variables, the scheduler, and live evaluation logins must be configured before claiming the brief is complete.
