# Velocity Campaign Portal

A multi-tenant campaign workspace for Kilele Rides, Karoo Coaches, and Marrakech Express. Built with React/TypeScript, Supabase Auth/Postgres, and a Cloudflare-compatible Vinext server. Owners preview and send campaigns or share password-protected results. Analysts can only read their own brand's data.

## Run locally

Requires Node 22.13+ and an empty Supabase project.

```sh
npm ci
cp .env.example .env
# Fill .env with the values described below.
npm run dev
```

Open the local URL printed by the development server. Without Supabase configuration, sign-in reports that the workspace is not connected; the app never substitutes fabricated customer data.

## Supabase setup

1. Create a dedicated project. Keep Data API enabled, disable automatically exposing new tables, and enable automatic RLS.
2. Execute `schema.sql` once in its SQL Editor, or apply the ordered files under `supabase/migrations/` with your normal migration tooling. The concatenated schema targets a fresh project; it is not a reset script.
3. Fill the ignored `.env` file:
   - `SUPABASE_URL`: project API URL.
   - `SUPABASE_ANON_KEY`: the project's public anon key (or supported publishable key).
   - `SUPABASE_SERVICE_ROLE_KEY`: privileged server-only key for ingestion, provisioning, background processing, and the narrow shared-report service.
   - `MESSAGING_API_KEY`: the candidate-specific key from Velocity's email.
   - `MESSAGING_BASE_URL`: the provider URL from the brief.
   - `APP_URL`: exact application origin, without a trailing slash.
   - `CRON_SECRET`: a random secret for the worker endpoint.
   - `DEMO_GOOGLE_EMAIL`: a real Google email you control, assigned to Kilele's owner.
4. Run `npm run provision`. This creates one owner and one analyst per brand, writes the generated passwords into an ignored `secrets/logins.json` file, and leaves existing users unchanged on rerun. The other five addresses use the synthetic `vg-eval.test` domain for password-based evaluation; Google sign-in requires a real Google identity with the exact approved email.
5. Disable new user signups in Supabase Auth. No self-registration UI exists, and an authenticated identity without a protected membership has no data access.
6. Configure the Google provider with your Google OAuth web client ID/secret. Register Supabase's callback URL (`https://PROJECT_REF.supabase.co/auth/v1/callback`) in Google. Set the app's Site URL and allow `${APP_URL}/auth/callback` in Supabase. Use only `openid`, email, and profile scopes. Test that Google login resolves to the same membership as password login. `scripts/configure-auth.ts` supports management-API configuration if an access token and Google credentials are available.

Public browser configuration is served by `/api/config`. It includes only the project URL and public key. It never includes the service key, provider key, passwords, or cron secret. Do not use the privileged key for browser clients.

## Load the supplied exports

The synthetic data is deliberately excluded from this repository. Download the ZIP linked in the brief and verify SHA-256:

```text
4961a25b151ca13ac56089ca46b94def6074c315445ec193c7bf87060683d35c
```

Extract it into the ignored `data/` directory, preserving filenames.

```sh
npm run import:data -- data --dry-run
npm run import:data -- data
```

The importer loads baseline contacts, the September delta, campaigns, the send log, and events in dependency order. Replaying a completed checksum is a no-op. Diagnostics are available in the portal's Import history. The UI reads paginated rows and SQL aggregates; it does not download the entire customer dataset.

## Background sends and reports

The application persists jobs before returning confirmation. A background worker is mandatory for dispatch and report updates.

```sh
npm run worker             # one bounded invocation
npm run worker -- --watch  # continuous worker in a supervised Node process
```

Alternatively schedule `POST ${APP_URL}/api/worker` every minute with `Authorization: Bearer ${CRON_SECRET}`. `supabase/scheduler.sql` provides a Supabase Cron/pg_net setup using Vault secrets. The application must be publicly reachable at the hosting layer for an external scheduler to call that endpoint; the endpoint itself requires its secret. Do not rely on a browser timer or a fire-and-forget web request for delivery.

The provider integration uses batches of 25, persisted idempotency keys, explicit acknowledgement validation, leases, exponential backoff, event deduplication, recipient-mapping validation, and monotonic suppression. An uncertain send is not reported as delivered. A campaign can be sent once from the portal; repeated confirmation returns or protects the existing send.

## Verification

```sh
npm run typecheck
npm test
npm run verify:seed
npm run build
```

`npm test` runs the real schema in PGlite/Postgres and pure domain tests without any network credentials. The isolation regression test demonstrates failure when RLS is disabled. `npm run verify:seed` exercises all supplied CSVs through the real SQL importer and writes a private local summary under `work/`. Hosted Supabase/OAuth, concurrent external sessions, the deployed runtime, and the scheduled worker still require the live checks in `docs/acceptance.md`.

## Deployment

Build with `npm run build`. The Sites deployment uses `.openai/hosting.json` and the generated Cloudflare Worker artifact. Set the same server runtime secrets through the hosting provider; local `.env` files are never bundled. `APP_URL` must match the deployed origin before generating shared links and configuring OAuth.

The source is organized for portability: the UI uses Next-compatible routes and the integration depends on HTTP-based Supabase APIs. The standalone Node worker can run separately from the web host. Supabase remains the authoritative database/authentication provider.

## Review guide

Start with `docs/architecture.md` for the authorization model, import decisions, metrics, and failure recovery. `docs/acceptance.md` lists the live acceptance checks. `docs/provider-verification.md` distinguishes observed provider behavior from unverified assumptions. `docs/submission.md` tracks the employer's required handoff.

The Supabase keys appropriate for evaluation are the project URL and public anon key plus the six test logins. Share the issued messaging key privately as requested in the brief. Never publish the service key, Google client secret, cron secret, test passwords, or report password.

## AI assistance

Implementation and validation used OpenAI Codex. Human review should focus on the guarantees and the explicitly documented limits rather than treating generated code or a green build as evidence of production correctness.
