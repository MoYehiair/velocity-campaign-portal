import { adminDatabase, requireResult } from './supabase';
import { dispatch, eventPage, ProviderError } from './provider';
import { normalizeEvent, type Recipient } from '../domain/provider';
import type { SendJob } from '../domain/types';

/** Each invocation does bounded work. Persisted jobs/batches survive process exits. */
export async function runWorker() {
  const db = adminDatabase();
  const started = Date.now();
  let dispatched = 0,
    pages = 0;
  const claimed = await db.rpc('claim_send_job');
  if (claimed.error) throw claimed.error;
  const job = claimed.data as SendJob | null;
  if (job?.id) {
    requireResult(
      await db
        .rpc('prepare_send_batches', {
          p_job: job.id,
          p_lease: job.lease_token,
        })
        .then((r) => ({ ...r, data: r.error ? null : true })),
    );
    const current = requireResult(
      await db
        .from('send_jobs')
        .select('status')
        .eq('id', job.id)
        .single<{ status: string }>(),
    );
    if (current.status !== 'blocked') {
      const approval = requireResult(
        await db
          .from('send_approvals')
          .select('*')
          .eq('id', job.approval_id)
          .single<{ campaign_name: string; channel: string }>(),
      );
      const batches = requireResult(
        await db
          .from('send_batches')
          .select('*')
          .eq('job_id', job.id)
          .in('status', ['pending', 'uncertain'])
          .order('batch_number')
          .limit(10),
      );
      for (const batch of batches) {
        if (Date.now() - started > 20000) break;
        // Retry the exact stored payload with the same key; never rebuild it after an uncertain response.
        try {
          const eligible = await db.rpc('authorize_batch_attempt', {
            p_batch: batch.id,
            p_lease: job.lease_token,
          });
          if (eligible.error) throw eligible.error;
          if (!eligible.data) break;
          const result = await dispatch(
            batch.idempotency_key,
            job.tenant_id,
            approval.campaign_name,
            approval.channel,
            batch.recipients,
          );
          const saved = await db
            .from('send_batches')
            .update({
              provider_batch_id: result.batch_id,
              accepted: result.accepted,
              rejected: result.rejected,
              status: result.rejected.length ? 'partial' : 'accepted',
              last_error: null,
            })
            .eq('id', batch.id);
          if (saved.error) throw saved.error;
          dispatched++;
        } catch (error) {
          const terminal =
            error instanceof ProviderError &&
            [400, 401, 403, 404, 422].includes(error.status);
          const saved = await db
            .from('send_batches')
            .update({
              status: terminal ? 'failed' : 'uncertain',
              last_error: (error as Error).message,
            })
            .eq('id', batch.id);
          if (saved.error) throw saved.error;
          break;
        }
      }
      const refreshed = await db.rpc('refresh_send_job', {
        p_job: job.id,
        p_lease: job.lease_token,
      });
      if (refreshed.error) throw refreshed.error;
    }
  }
  // Old batches remain eligible for polling: closing the browser never stops delivery updates.
  const pollable = requireResult(
    await db
      .from('send_batches')
      .select('*')
      .not('provider_batch_id', 'is', null)
      .order('last_polled_at', { ascending: true, nullsFirst: true })
      .limit(10),
  );
  for (const batch of pollable) {
    if (Date.now() - started > 25000) break;
    try {
      let cursor = batch.event_cursor as string | null;
      for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
        if (Date.now() - started > 25000) break;
        const page = await eventPage(batch.provider_batch_id, cursor);
        const valid = [];
        for (const raw of page.events) {
          try {
            valid.push(normalizeEvent(raw, batch.recipients as Recipient[]));
          } catch (error) {
            const saved = await db.from('provider_issues').insert({
              tenant_id: batch.tenant_id,
              batch_id: batch.id,
              reason: (error as Error).message,
              raw,
            });
            if (saved.error) throw saved.error;
          }
        }
        if (page.has_more && page.next_cursor === cursor)
          throw new Error('Provider cursor did not advance');
        // The terminal page returns null. Replay from the beginning next sweep to capture late reports.
        const result = await db.rpc('store_provider_page', {
          p_batch: batch.id,
          p_events: valid,
          p_cursor: page.next_cursor,
        });
        if (result.error) throw result.error;
        pages++;
        cursor = page.next_cursor;
        if (!page.has_more) break;
      }
    } catch (error) {
      const saved = await db
        .from('send_batches')
        .update({
          poll_error: (error as Error).message,
          last_polled_at: new Date().toISOString(),
        })
        .eq('id', batch.id);
      if (saved.error) throw saved.error;
    }
  }
  return { dispatched, pages };
}
