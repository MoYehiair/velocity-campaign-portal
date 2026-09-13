begin;

-- This function only returns metrics for the authenticated member's tenant.
create function public.dashboard_metrics () returns jsonb language sql stable security invoker
set
  search_path = '' as $$
  select
    jsonb_build_object(
      'customers',
      (
        select
          count(*)
        from
          public.contacts
        where
          deleted_at is null
      ),
      'contactable',
      (
        select
          count(*)
        from
          public.contacts c
        where
          public.is_contactable (c, 'email')
          or public.is_contactable (c, 'sms')
      ),
      'email_contactable',
      (
        select
          count(*)
        from
          public.contacts c
        where
          public.is_contactable (c, 'email')
      ),
      'sms_contactable',
      (
        select
          count(*)
        from
          public.contacts c
        where
          public.is_contactable (c, 'sms')
      ),
      'campaigns',
      (
        select
          count(*)
        from
          public.campaigns
      ),
      'signup_days',
      (
        select
          coalesce(
            jsonb_agg(
              jsonb_build_object('day', d.day, 'count', d.n)
              order by
                d.day
            ),
            '[]'
          )
        from
          (
            select
              g::date as day,
              count(c.external_id) as n
            from
              public.tenants t
              cross join lateral generate_series(
                (now() at time zone t.timezone)::date -29,
                (now() at time zone t.timezone)::date,
                interval '1 day'
              ) g
              left join public.contacts c on c.tenant_id = t.id
              and c.deleted_at is null
              and (c.signup_at at time zone t.timezone)::date = g::date
            group by
              g::date
          ) d
      ),
      'as_of',
      now()
    )
$$;

create function public.campaign_metrics (p_campaign text) returns jsonb language sql stable security invoker
set
  search_path = '' as $$
  select
    jsonb_build_object(
      'campaign',
      to_jsonb(c),
      'unique_opens',
      (
        select
          count(distinct external_contact_id)
        from
          public.engagement_events
        where
          tenant_id = c.tenant_id
          and campaign_external_id = c.external_id
          and event_type = 'open'
      ),
      'unique_clicks',
      (
        select
          count(distinct external_contact_id)
        from
          public.engagement_events
        where
          tenant_id = c.tenant_id
          and campaign_external_id = c.external_id
          and event_type = 'click'
      ),
      'event_count',
      (
        select
          count(*)
        from
          public.engagement_events
        where
          tenant_id = c.tenant_id
          and campaign_external_id = c.external_id
      ),
      'historical_sent',
      (
        select
          sum(recipient_count)
        from
          public.historical_sends
        where
          tenant_id = c.tenant_id
          and campaign_external_id = c.external_id
      ),
      'live_delivered',
      (
        select
          count(distinct (e.batch_id, e.external_contact_id))
        from
          public.provider_events e
          join public.send_batches b on b.id = e.batch_id
          join public.send_jobs j on j.id = b.job_id
        where
          j.tenant_id = c.tenant_id
          and j.campaign_external_id = c.external_id
          and e.event_type = 'delivered'
      ),
      'live_opened',
      (
        select
          count(distinct (e.batch_id, e.external_contact_id))
        from
          public.provider_events e
          join public.send_batches b on b.id = e.batch_id
          join public.send_jobs j on j.id = b.job_id
        where
          j.tenant_id = c.tenant_id
          and j.campaign_external_id = c.external_id
          and e.event_type = 'opened'
      ),
      'live_bounced',
      (
        select
          count(distinct (e.batch_id, e.external_contact_id))
        from
          public.provider_events e
          join public.send_batches b on b.id = e.batch_id
          join public.send_jobs j on j.id = b.job_id
        where
          j.tenant_id = c.tenant_id
          and j.campaign_external_id = c.external_id
          and e.event_type = 'bounced'
      ),
      'live_unsubscribed',
      (
        select
          count(distinct (e.batch_id, e.external_contact_id))
        from
          public.provider_events e
          join public.send_batches b on b.id = e.batch_id
          join public.send_jobs j on j.id = b.job_id
        where
          j.tenant_id = c.tenant_id
          and j.campaign_external_id = c.external_id
          and e.event_type = 'unsubscribed'
      )
    )
  from
    public.campaigns c
  where
    external_id = p_campaign
$$;

create function public.contact_page (
  p_page integer default 0,
  p_search text default ''
) returns jsonb language sql stable security invoker
set
  search_path = '' as $$
  select
    jsonb_build_object(
      'total',
      (
        select
          count(*)
        from
          public.contacts
        where
          deleted_at is null
          and (
            p_search = ''
            or full_name ilike '%' || left(p_search, 100) || '%'
            or email ilike '%' || left(p_search, 100) || '%'
          )
      ),
      'rows',
      coalesce(
        (
          select
            jsonb_agg(to_jsonb(x))
          from
            (
              select
                c.*,
                public.is_contactable (c, 'email') as email_contactable,
                public.is_contactable (c, 'sms') as sms_contactable
              from
                public.contacts c
              where
                deleted_at is null
                and (
                  p_search = ''
                  or full_name ilike '%' || left(p_search, 100) || '%'
                  or email ilike '%' || left(p_search, 100) || '%'
                )
              order by
                full_name,
                external_id
              limit
                50
              offset
                greatest(0, least(p_page, 100000)) * 50
            ) x
        ),
        '[]'
      )
    )
$$;

-- Only the trusted worker can claim jobs. The lease is renewed through each write.
create function public.claim_send_job () returns public.send_jobs language plpgsql security definer
set
  search_path = '' as $$
  declare j public.send_jobs;
  
  begin
  select
    * into j
  from
    public.send_jobs
  where
    status in ('queued', 'sending', 'uncertain')
    and (
      lease_until is null
      or lease_until < now()
    )
  order by
    created_at
  for update
    skip locked
  limit
    1;
  
  if not found then return null;
  
  end if;
  
  update public.send_jobs
  set
    status = 'sending',
    lease_until = now() + interval '2 minutes',
    lease_token = gen_random_uuid(),
    updated_at = now()
  where
    id = j.id
  returning
    * into j;
  
  return j;
  
  end
$$;

create function public.prepare_send_batches (p_job uuid, p_lease uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
  declare j public.send_jobs;
  
  a public.send_approvals;
  
  begin
  select
    * into j
  from
    public.send_jobs
  where
    id = p_job
    and lease_token = p_lease
  for update;
  
  if not found then raise exception 'Lease lost';
  
  end if;
  
  if exists (
    select
      1
    from
      public.send_batches
    where
      job_id = j.id
  ) then return;
  
  end if;
  
  select
    * into a
  from
    public.send_approvals
  where
    id = j.approval_id;
  
  -- Fail the whole job closed if consent or destination changed before dispatch.
  if exists (
    select
      1
    from
      public.approval_recipients r
      join public.contacts c on (
        c.tenant_id = r.tenant_id
        and c.external_id = r.external_contact_id
      )
    where
      r.approval_id = a.id
      and (
        not public.is_contactable (c, a.channel)
        or r.destination is distinct from case a.channel
          when 'email' then c.email
          else c.phone
        end
        or (
          a.target_country is not null
          and c.country is distinct from a.target_country
        )
      )
  ) then
  update public.send_jobs
  set
    status = 'blocked',
    last_error = 'Audience eligibility changed after approval; no messages dispatched.',
    lease_until = null
  where
    id = j.id;
  
  return;
  
  end if;
  
  insert into
    public.send_batches (
      tenant_id,
      job_id,
      batch_number,
      idempotency_key,
      recipients
    )
  select
    j.tenant_id,
    j.id,
    n,
    'vg:' || j.id || ':' || n,
    jsonb_agg(
      jsonb_build_object(
        'id',
        j.tenant_id || ':' || external_contact_id,
        'external_id',
        external_contact_id,
        'destination',
        destination
      )
      order by
        external_contact_id
    )
  from
    (
      select
        r.*,
        (
          (
            row_number() over (
              order by
                external_contact_id
            ) -1
          ) / 25
        )::integer as n
      from
        public.approval_recipients r
      where
        approval_id = a.id
    ) x
  group by
    n;
  
  end
$$;

create function public.store_provider_page (p_batch uuid, p_events jsonb, p_cursor text) returns void language plpgsql security definer
set
  search_path = '' as $$
  declare b public.send_batches;
  
  e jsonb;
  
  cid text;
  
  kind text;
  
  occurred timestamptz;
  
  begin
  select
    * into b
  from
    public.send_batches
  where
    id = p_batch
  for update;
  
  if not found then raise exception 'Batch not found';
  
  end if;
  
  for e in
  select
    value
  from
    jsonb_array_elements(p_events) loop cid := e ->> 'external_contact_id';
  
  kind := e ->> 'event_type';
  
  occurred := (e ->> 'occurred_at')::timestamptz;
  
  if not exists (
    select
      1
    from
      jsonb_array_elements(b.recipients) r
    where
      r ->> 'external_id' = cid
  ) then raise exception 'Recipient does not belong to this batch';
  
  end if;
  
  insert into
    public.provider_events (
      tenant_id,
      batch_id,
      event_id,
      external_contact_id,
      event_type,
      occurred_at,
      raw
    )
  values
    (
      b.tenant_id,
      b.id,
      e ->> 'event_id',
      cid,
      kind,
      occurred,
      e -> 'raw'
    )
  on conflict do nothing;
  
  if kind in ('bounced', 'unsubscribed') then
  insert into
    public.suppressions (
      tenant_id,
      external_contact_id,
      channel,
      reason,
      occurred_at
    )
  select
    b.tenant_id,
    cid,
    a.channel,
    case kind
      when 'bounced' then 'bounce'
      else 'unsubscribe'
    end,
    occurred
  from
    public.send_jobs j
    join public.send_approvals a on a.id = j.approval_id
  where
    j.id = b.job_id
  on conflict (tenant_id, external_contact_id, channel, reason) do update
  set
    occurred_at = greatest(
      public.suppressions.occurred_at,
      excluded.occurred_at
    );
  
  end if;
  
  end loop;
  
  update public.send_batches
  set
    event_cursor = p_cursor,
    last_polled_at = now(),
    poll_error = null
  where
    id = b.id;
  
  end
$$;

-- Sharing uses a service-only aggregate projection; no contact records or operational payloads.
create function public.shared_campaign_results (p_tenant text, p_campaign text) returns jsonb language sql stable security definer
set
  search_path = '' as $$
  select
    jsonb_build_object(
      'brand',
      t.name,
      'campaign',
      c.campaign_name,
      'channel',
      c.channel,
      'reported_sent',
      c.reported_sent,
      'reported_delivered',
      c.reported_delivered,
      'reported_opens',
      c.reported_opens,
      'reported_clicks',
      c.reported_clicks,
      'unique_opens',
      (
        select
          count(distinct external_contact_id)
        from
          public.engagement_events
        where
          tenant_id = c.tenant_id
          and campaign_external_id = c.external_id
          and event_type = 'open'
      ),
      'unique_clicks',
      (
        select
          count(distinct external_contact_id)
        from
          public.engagement_events
        where
          tenant_id = c.tenant_id
          and campaign_external_id = c.external_id
          and event_type = 'click'
      ),
      'live_accepted',
      coalesce(
        (
          select
            sum(accepted_count)
          from
            public.send_jobs
          where
            tenant_id = c.tenant_id
            and campaign_external_id = c.external_id
        ),
        0
      ),
      'live_delivered',
      (
        select
          count(distinct (e.batch_id, e.external_contact_id))
        from
          public.provider_events e
          join public.send_batches b on b.id = e.batch_id
          join public.send_jobs j on j.id = b.job_id
        where
          j.tenant_id = c.tenant_id
          and j.campaign_external_id = c.external_id
          and e.event_type = 'delivered'
      ),
      'live_opened',
      (
        select
          count(distinct (e.batch_id, e.external_contact_id))
        from
          public.provider_events e
          join public.send_batches b on b.id = e.batch_id
          join public.send_jobs j on j.id = b.job_id
        where
          j.tenant_id = c.tenant_id
          and j.campaign_external_id = c.external_id
          and e.event_type = 'opened'
      ),
      'updated_at',
      now()
    )
  from
    public.campaigns c
    join public.tenants t on t.id = c.tenant_id
  where
    c.tenant_id = p_tenant
    and c.external_id = p_campaign
$$;

revoke all on function public.dashboard_metrics (),
public.campaign_metrics (text),
public.contact_page (integer, text),
public.claim_send_job (),
public.prepare_send_batches (uuid, uuid),
public.store_provider_page (uuid, jsonb, text),
public.shared_campaign_results (text, text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.dashboard_metrics (),
public.campaign_metrics (text),
public.contact_page (integer, text) to authenticated;

grant
execute on all functions in schema public to service_role;

commit;
