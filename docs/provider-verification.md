# Provider verification

Public docs: https://dispatcher-production-72fc.up.railway.app/v1/docs

## Observed during implementation

- The issued key authenticated successfully using the Bearer scheme.
- A one-recipient integration probe used a synthetic `vg-eval.test` destination from the supplied seed. The provider returned a batch ID, an accepted recipient list, accepted/rejected counts, and status `accepted`.
- Event pages contain `event_id`, `recipient_id`, `brand_code`, `type`, and `occurred_at`.
- A returned opaque `next_cursor` worked in the `since` query parameter, despite documentation describing the last event ID.
- An initial page said there were more events. A later sweep returned duplicate delivery/open events and an unrelated recipient labelled with another brand. The application validates against its persisted recipient mapping, never against the provider's brand label.
- Replaying the exact one-recipient request with the same idempotency key several hours later returned the original batch ID and an accepted count of one. This verifies that example, not an unlimited retention guarantee.
- The terminal response returned `next_cursor: null` and `has_more: false`.

Local raw probe records are ignored under `work/`. They contain no provider key. The one-recipient integration probe is separate from the portal's eventual campaign send and is not represented as an approved campaign.

## Do not infer from the docs

The docs claim clean, ordered, exactly-once reports. The observed duplicates and unrelated event contradict that claim. The brief also explicitly warns about messy and out-of-order reports.

The advertised 100,000-recipient limit and 600 requests/minute have not been stress-tested. The application uses conservative 25-recipient batches and bounded worker invocations. Idempotency lifetime, partial-acceptance behavior at scale, and timeout recovery must be verified against the live service before claiming end-to-end acceptance. Unit tests cover malformed/incomplete acknowledgements and event handling, not undocumented provider guarantees.
