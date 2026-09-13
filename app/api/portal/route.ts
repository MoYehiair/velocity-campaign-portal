import { authenticated, json, route, HttpError } from '@/lib/server/http';
import { requireResult } from '@/lib/server/supabase';
export function GET(request: Request) {
  return route(async () => {
    const { db, membership } = await authenticated(request);
    const url = new URL(request.url),
      view = url.searchParams.get('view') ?? 'dashboard';
    if (view === 'membership') return json(membership);
    if (view === 'dashboard')
      return json(requireResult(await db.rpc('dashboard_metrics')));
    if (view === 'contacts') {
      const page = Number(url.searchParams.get('page') ?? 0);
      if (!Number.isInteger(page) || page < 0)
        throw new HttpError(400, 'Invalid page');
      return json(
        requireResult(
          await db.rpc('contact_page', {
            p_page: page,
            p_search: (url.searchParams.get('search') ?? '').slice(0, 100),
          }),
        ),
      );
    }
    if (view === 'campaigns')
      return json(
        requireResult(
          await db
            .from('campaigns')
            .select('*')
            .order('sent_at_utc', { ascending: false }),
        ),
      );
    if (view === 'campaign')
      return json(
        requireResult(
          await db.rpc('campaign_metrics', {
            p_campaign: url.searchParams.get('id'),
          }),
        ),
      );
    if (view === 'jobs')
      return json(
        requireResult(
          await db
            .from('send_jobs')
            .select('*')
            .order('created_at', { ascending: false }),
        ),
      );
    if (view === 'imports')
      return json(
        requireResult(
          await db
            .from('import_runs')
            .select('*')
            .order('created_at', { ascending: false }),
        ),
      );
    if (view === 'issues') {
      const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
      if (!Number.isInteger(page)) throw new HttpError(400, 'Invalid page');
      const result = await db
        .from('import_issues')
        .select('*', { count: 'exact' })
        .eq('import_id', url.searchParams.get('id'))
        .order('row_number')
        .range(page * 50, page * 50 + 49);
      if (result.error) throw result.error;
      return json({ rows: result.data, total: result.count });
    }
    if (view === 'recipients') {
      const approval = requireResult(
        await db
          .from('send_approvals')
          .select('*')
          .eq('id', url.searchParams.get('id'))
          .single<{ id: string; recipient_count: number }>(),
      );
      const page = Math.max(0, Number(url.searchParams.get('page') ?? 0));
      if (!Number.isInteger(page)) throw new HttpError(400, 'Invalid page');
      const recipients = requireResult(
        await db
          .from('approval_recipients')
          .select('external_contact_id,full_name,destination')
          .eq('approval_id', approval.id)
          .order('external_contact_id')
          .range(page * 50, page * 50 + 49),
      );
      return json({ approval, recipients });
    }
    if (view === 'batches') {
      const page = Number(url.searchParams.get('page') ?? 0);
      if (!Number.isInteger(page) || page < 0)
        throw new HttpError(400, 'Invalid page');
      const result = await db
        .from('send_batches')
        .select(
          'id,status,batch_number,provider_batch_id,last_polled_at,poll_error,last_error',
          { count: 'exact' },
        )
        .eq('job_id', url.searchParams.get('id'))
        .order('batch_number')
        .range(page * 50, page * 50 + 49);
      if (result.error) throw result.error;
      return json({ rows: result.data, total: result.count });
    }
    throw new HttpError(400, 'Unknown view');
  });
}
