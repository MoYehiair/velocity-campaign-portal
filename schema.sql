-- Brand isolation is enforced here, including requests made directly to PostgREST.
-- No application user receives direct write permission on operational tables.
begin;

create table public.tenants (
  id text primary key check (id in ('kilele', 'karoo', 'marrakech')),
  name text not null,
  country text not null,
  timezone text not null
);

insert into
  public.tenants
values
  ('kilele', 'Kilele Rides', 'KE', 'Africa/Nairobi'),
  (
    'karoo',
    'Karoo Coaches',
    'ZA',
    'Africa/Johannesburg'
  ),
  (
    'marrakech',
    'Marrakech Express',
    'MA',
    'Africa/Casablanca'
  );

create table public.memberships (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tenant_id text not null references public.tenants (id),
  email text not null unique,
  role text not null check (role in ('owner', 'analyst')),
  unique (tenant_id, role)
);

create function public.current_tenant () returns text language sql stable security definer
set
  search_path = '' as $$
  select
    tenant_id
  from
    public.memberships
  where
    user_id = auth.uid ()
$$;

create function public.is_owner () returns boolean language sql stable security definer
set
  search_path = '' as $$
  select
    coalesce(
      (
        select
          role = 'owner'
        from
          public.memberships
        where
          user_id = auth.uid ()
      ),
      false
    )
$$;

create table public.contacts (
  tenant_id text not null references public.tenants,
  external_id text not null check (external_id ~ '^CT-[0-9]+$'),
  full_name text not null,
  email text,
  phone text,
  country text,
  city text,
  signup_at timestamptz,
  status text not null check (
    status in ('active', 'pending', 'unsubscribed', 'bounced')
  ),
  consent_marketing boolean not null default false,
  deleted_at timestamptz,
  suppressed_until timestamptz,
  source_version date not null,
  source_file text not null,
  primary key (tenant_id, external_id)
);

create index contacts_signup on public.contacts (tenant_id, signup_at);

create index contacts_name on public.contacts (tenant_id, full_name, external_id);

create table public.campaigns (
  tenant_id text not null references public.tenants,
  external_id text not null,
  campaign_name text not null,
  channel text not null check (channel in ('email', 'sms')),
  target_country text,
  parent_campaign_id text,
  reported_sent integer check (reported_sent >= 0),
  reported_delivered integer check (reported_delivered >= 0),
  reported_bounced integer check (reported_bounced >= 0),
  reported_opens integer check (reported_opens >= 0),
  reported_clicks integer check (reported_clicks >= 0),
  spend numeric(14, 2) check (spend >= 0),
  sent_at_utc timestamptz,
  primary key (tenant_id, external_id)
);

create table public.engagement_events (
  tenant_id text not null,
  event_id text not null,
  external_contact_id text not null,
  campaign_external_id text not null,
  event_type text not null check (
    event_type in (
      'open',
      'click',
      'bounce',
      'complaint',
      'unsubscribe',
      'delivered'
    )
  ),
  channel text not null check (channel in ('email', 'sms')),
  occurred_at_utc timestamptz not null,
  primary key (tenant_id, event_id),
  foreign key (tenant_id, external_contact_id) references public.contacts (tenant_id, external_id),
  foreign key (tenant_id, campaign_external_id) references public.campaigns (tenant_id, external_id)
);

create index events_campaign on public.engagement_events (
  tenant_id,
  campaign_external_id,
  event_type,
  external_contact_id
);

create table public.suppressions (
  tenant_id text not null,
  external_contact_id text not null,
  channel text not null check (channel in ('email', 'sms')),
  reason text not null check (reason in ('bounce', 'complaint', 'unsubscribe')),
  occurred_at timestamptz not null,
  primary key (tenant_id, external_contact_id, channel, reason),
  foreign key (tenant_id, external_contact_id) references public.contacts (tenant_id, external_id)
);

create function public.record_historical_suppression () returns trigger language plpgsql security definer
set
  search_path = '' as $$
  begin if new.event_type in ('bounce', 'complaint', 'unsubscribe') then
  insert into
    public.suppressions
  values
    (
      new.tenant_id,
      new.external_contact_id,
      new.channel,
      new.event_type,
      new.occurred_at_utc
    )
  on conflict (tenant_id, external_contact_id, channel, reason) do update
  set
    occurred_at = greatest(
      public.suppressions.occurred_at,
      excluded.occurred_at
    );
  
  end if;
  
  return new;
  
  end
$$;

create trigger historical_suppression
after insert on public.engagement_events for each row
execute function public.record_historical_suppression ();

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants,
  file_name text not null,
  checksum text not null,
  source_version date not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  total_rows integer not null default 0,
  loaded_rows integer not null default 0,
  rejected_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  warning_rows integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, checksum),
  unique (tenant_id, id)
);

create table public.import_issues (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  import_id uuid not null,
  row_number integer not null,
  severity text not null check (severity in ('error', 'warning', 'duplicate')),
  reason text not null,
  external_id text,
  foreign key (tenant_id, import_id) references public.import_runs (tenant_id, id)
);

create table public.historical_sends (
  tenant_id text not null,
  batch_key text not null,
  campaign_external_id text not null,
  queued_at_utc timestamptz not null,
  recipient_count integer not null check (recipient_count >= 0),
  status text not null check (status = 'sent'),
  primary key (tenant_id, batch_key),
  foreign key (tenant_id, campaign_external_id) references public.campaigns (tenant_id, external_id)
);

-- Eligibility admits only known-good records. Unknown consent is false at ingestion.
create function public.is_contactable (
  c public.contacts,
  p_channel text,
  p_at timestamptz default now()
) returns boolean language sql stable security invoker
set
  search_path = '' as $$
  select
    c.status = 'active'
    and c.consent_marketing
    and c.deleted_at is null
    and (
      c.suppressed_until is null
      or c.suppressed_until <= p_at
    )
    and case p_channel
      when 'email' then c.email is not null
      when 'sms' then c.phone is not null
      else false
    end
    and not exists (
      select
        1
      from
        public.suppressions s
      where
        s.tenant_id = c.tenant_id
        and s.external_contact_id = c.external_id
        and s.channel = p_channel
    )
$$;

create table public.send_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  campaign_external_id text not null,
  campaign_name text not null,
  channel text not null check (channel in ('email', 'sms')),
  target_country text,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  recipient_count integer not null default 0,
  approved_at timestamptz,
  approved_by uuid references auth.users,
  unique (tenant_id, id),
  foreign key (tenant_id, campaign_external_id) references public.campaigns (tenant_id, external_id)
);

create table public.approval_recipients (
  tenant_id text not null,
  approval_id uuid not null,
  external_contact_id text not null,
  full_name text not null,
  destination text not null,
  primary key (tenant_id, approval_id, external_contact_id),
  foreign key (tenant_id, approval_id) references public.send_approvals (tenant_id, id),
  foreign key (tenant_id, external_contact_id) references public.contacts (tenant_id, external_id)
);

create table public.send_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  approval_id uuid not null unique,
  campaign_external_id text not null,
  status text not null default 'queued' check (
    status in (
      'queued',
      'sending',
      'accepted',
      'partial',
      'blocked',
      'uncertain',
      'failed'
    )
  ),
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  skipped_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  unique (tenant_id, id),
  unique (tenant_id, campaign_external_id),
  foreign key (tenant_id, approval_id) references public.send_approvals (tenant_id, id),
  foreign key (tenant_id, campaign_external_id) references public.campaigns (tenant_id, external_id)
);

create table public.send_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  job_id uuid not null,
  batch_number integer not null,
  idempotency_key text not null unique,
  recipients jsonb not null,
  status text not null default 'pending' check (
    status in (
      'pending',
      'accepted',
      'partial',
      'uncertain',
      'failed'
    )
  ),
  provider_batch_id text unique,
  accepted jsonb,
  rejected jsonb,
  last_error text,
  event_cursor text,
  last_polled_at timestamptz,
  poll_error text,
  unique (job_id, batch_number),
  unique (tenant_id, id),
  foreign key (tenant_id, job_id) references public.send_jobs (tenant_id, id)
);

create table public.provider_events (
  tenant_id text not null,
  batch_id uuid not null,
  event_id text not null,
  external_contact_id text not null,
  event_type text not null check (
    event_type in ('delivered', 'bounced', 'opened', 'unsubscribed')
  ),
  occurred_at timestamptz not null,
  raw jsonb not null,
  primary key (tenant_id, batch_id, event_id),
  foreign key (tenant_id, batch_id) references public.send_batches (tenant_id, id),
  foreign key (tenant_id, external_contact_id) references public.contacts (tenant_id, external_id)
);

create table public.provider_issues (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  batch_id uuid not null,
  reason text not null,
  raw jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, batch_id) references public.send_batches (tenant_id, id)
);

create function public.preview_campaign (p_campaign text) returns uuid language plpgsql security definer
set
  search_path = '' as $$
  declare t text := public.current_tenant ();
  
  c public.campaigns;
  
  a uuid;
  
  begin if not public.is_owner () then raise exception 'Only owners can prepare a send' using errcode = '42501';
  
  end if;
  
  select
    * into c
  from
    public.campaigns
  where
    tenant_id = t
    and external_id = p_campaign;
  
  if not found then raise exception 'Campaign not found';
  
  end if;
  
  if exists (
    select
      1
    from
      public.send_jobs
    where
      tenant_id = t
      and campaign_external_id = p_campaign
  ) then raise exception 'This campaign already has a send. Review its progress.';
  
  end if;
  
  insert into
    public.send_approvals (
      tenant_id,
      campaign_external_id,
      campaign_name,
      channel,
      target_country,
      created_by
    )
  values
    (
      t,
      c.external_id,
      c.campaign_name,
      c.channel,
      c.target_country,
      auth.uid ()
    )
  returning
    id into a;
  
  insert into
    public.approval_recipients (
      tenant_id,
      approval_id,
      external_contact_id,
      full_name,
      destination
    )
  select distinct
    on (
      case c.channel
        when 'email' then email
        else phone
      end
    ) t,
    a,
    external_id,
    full_name,
    case c.channel
      when 'email' then email
      else phone
    end
  from
    public.contacts x
  where
    x.tenant_id = t
    and public.is_contactable (x, c.channel)
    and (
      c.target_country is null
      or x.country = c.target_country
    )
  order by
    case c.channel
      when 'email' then email
      else phone
    end,
    external_id;
  
  update public.send_approvals
  set
    recipient_count = (
      select
        count(*)
      from
        public.approval_recipients
      where
        tenant_id = t
        and approval_id = a
    )
  where
    id = a;
  
  return a;
  
  end
$$;

create function public.confirm_campaign (p_approval uuid) returns uuid language plpgsql security definer
set
  search_path = '' as $$
  declare t text := public.current_tenant ();
  
  a public.send_approvals;
  
  j uuid;
  
  begin if not public.is_owner () then raise exception 'Only owners can send' using errcode = '42501';
  
  end if;
  
  select
    * into a
  from
    public.send_approvals
  where
    tenant_id = t
    and id = p_approval
  for update;
  
  if not found then raise exception 'Approval not found';
  
  end if;
  
  select
    id into j
  from
    public.send_jobs
  where
    approval_id = a.id;
  
  if found then return j;
  
  end if;
  
  if a.expires_at < now() then raise exception 'Preview expired. Review recipients again.';
  
  end if;
  
  if a.recipient_count = 0 then raise exception 'No contactable recipients';
  
  end if;
  
  -- Revalidate the entire snapshot before acceptance. Never silently replace it.
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
      r.tenant_id = t
      and r.approval_id = a.id
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
  ) then raise exception 'Audience changed. Review a fresh preview before confirming.';
  
  end if;
  
  insert into
    public.send_jobs (tenant_id, approval_id, campaign_external_id)
  values
    (t, a.id, a.campaign_external_id)
  on conflict (tenant_id, campaign_external_id) do nothing
  returning
    id into j;
  
  if j is null then raise exception 'This campaign already has a send. Review its progress.';
  
  end if;
  
  update public.send_approvals
  set
    approved_at = now(),
    approved_by = auth.uid ()
  where
    id = a.id;
  
  return j;
  
  end
$$;

create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  campaign_external_id text not null,
  token_hash text not null unique,
  password_hash text not null,
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, campaign_external_id) references public.campaigns (tenant_id, external_id)
);

create table public.share_sessions (
  token_hash text primary key,
  link_id uuid not null references public.share_links on delete cascade,
  expires_at timestamptz not null
);

create table public.share_attempts (
  bucket text primary key,
  attempts integer not null default 1,
  window_start timestamptz not null default now()
);

create function public.allow_share_attempt (p_bucket text) returns boolean language plpgsql security definer
set
  search_path = '' as $$
  declare n integer;
  
  begin
  insert into
    public.share_attempts (bucket)
  values
    (p_bucket)
  on conflict (bucket) do update
  set
    attempts = case
      when public.share_attempts.window_start < now() - interval '15 minutes' then 1
      else public.share_attempts.attempts + 1
    end,
    window_start = case
      when public.share_attempts.window_start < now() - interval '15 minutes' then now()
      else public.share_attempts.window_start
    end
  returning
    attempts into n;
  
  return n <= 10;
  
  end
$$;

-- RLS and grants are deliberate allowlists. Newly created tables receive no client grants.
do $$
  declare tbl text;
  
  begin foreach tbl in array array[
    'tenants',
    'memberships',
    'contacts',
    'campaigns',
    'engagement_events',
    'suppressions',
    'import_runs',
    'import_issues',
    'historical_sends',
    'send_approvals',
    'approval_recipients',
    'send_jobs',
    'send_batches',
    'provider_events',
    'provider_issues',
    'share_links',
    'share_sessions',
    'share_attempts'
  ] loop
  execute format(
    'alter table public.%I enable row level security',
    tbl
  );
  
  execute format(
    'revoke all on public.%I from anon, authenticated',
    tbl
  );
  
  execute format('grant all on public.%I to service_role', tbl);
  
  end loop;
  
  foreach tbl in array array[
    'contacts',
    'campaigns',
    'engagement_events',
    'suppressions',
    'import_runs',
    'import_issues',
    'historical_sends',
    'send_approvals',
    'approval_recipients',
    'send_jobs',
    'send_batches',
    'provider_events',
    'provider_issues'
  ] loop
  execute format(
    'create policy tenant_read on public.%I for select to authenticated using (tenant_id = (select public.current_tenant()))',
    tbl
  );
  
  execute format('grant select on public.%I to authenticated', tbl);
  
  end loop;
  
  end
$$;

create policy tenant_read on public.tenants for
select
  to authenticated using (
    id = (
      select
        public.current_tenant ()
    )
  );

create policy self_read on public.memberships for
select
  to authenticated using (
    user_id = (
      select
        auth.uid ()
    )
  );

grant
select
  on public.tenants,
  public.memberships to authenticated;

grant usage,
select
  on all sequences in schema public to service_role;

revoke all on all functions in schema public
from
  public,
  anon,
  authenticated;

grant
execute on function public.current_tenant (),
public.is_owner (),
public.is_contactable (public.contacts, text, timestamptz),
public.preview_campaign (text),
public.confirm_campaign (uuid) to authenticated;

grant
execute on all functions in schema public to service_role;

alter default privileges in schema public
revoke all on tables
from
  anon,
  authenticated;

alter default privileges
revoke
execute on functions
from
  public,
  anon,
  authenticated;

commit;
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
begin;

-- Narrow service-only ingestion boundary. Table names never come from SQL interpolation unchecked.
create function public.import_row_batch (p_table text, p_rows jsonb, p_import uuid) returns jsonb language plpgsql security definer
set
  search_path = '' as $$
  declare r jsonb;
  
  run public.import_runs;
  
  loaded integer := 0;
  
  rejected integer := 0;
  
  failure_reason text;
  
  key_name text;
  
  existing jsonb;
  
  changes text;
  
  source_row integer;
  
  begin if p_table not in (
    'contacts',
    'campaigns',
    'engagement_events',
    'historical_sends'
  ) then raise exception 'Unsupported import table';
  
  end if;
  
  select
    * into run
  from
    public.import_runs
  where
    id = p_import;
  
  if not found
  or run.status <> 'running' then raise exception 'Import is not running';
  
  end if;
  
  if jsonb_array_length(p_rows) > 500 then raise exception 'Import batch too large';
  
  end if;
  
  key_name := case p_table
    when 'engagement_events' then 'event_id'
    when 'historical_sends' then 'batch_key'
    else 'external_id'
  end;
  
  for r in
  select
    value
  from
    jsonb_array_elements(p_rows) loop
  begin source_row := coalesce((r ->> '_source_row')::int, 0);
  
  if r ->> 'tenant_id' is distinct from run.tenant_id then raise exception 'Source brand mismatch';
  
  end if;
  
  if p_table = 'contacts' then
  insert into
    public.contacts
  select
    *
  from
    jsonb_populate_record(null::public.contacts, r)
  on conflict (tenant_id, external_id) do update
  set
    full_name = excluded.full_name,
    email = excluded.email,
    phone = excluded.phone,
    country = excluded.country,
    city = excluded.city,
    signup_at = excluded.signup_at,
    status = excluded.status,
    consent_marketing = excluded.consent_marketing,
    deleted_at = coalesce(public.contacts.deleted_at, excluded.deleted_at),
    suppressed_until = excluded.suppressed_until,
    source_version = excluded.source_version,
    source_file = excluded.source_file
  where
    excluded.source_version > public.contacts.source_version;
  
  else
  execute format(
    'select to_jsonb(x) from public.%I x where tenant_id=$1 and %I=$2',
    p_table,
    key_name
  ) into existing using run.tenant_id,
  r ->> key_name;
  
  execute format(
    'select to_jsonb(jsonb_populate_record(null::public.%I,$1))',
    p_table
  ) into r using r;
  
  if existing is not null
  and existing is distinct from r then raise exception 'Existing identifier has conflicting values; quarantined';
  
  end if;
  
  -- Orphan campaign reports can still contain a valid contact opt-out. Preserve that suppression.
  if p_table = 'engagement_events'
  and r ->> 'event_type' in ('bounce', 'unsubscribe', 'complaint')
  and exists (
    select
      1
    from
      public.contacts
    where
      tenant_id = run.tenant_id
      and external_id = r ->> 'external_contact_id'
  ) then
  insert into
    public.suppressions
  values
    (
      run.tenant_id,
      r ->> 'external_contact_id',
      r ->> 'channel',
      r ->> 'event_type',
      (r ->> 'occurred_at_utc')::timestamptz
    )
  on conflict (tenant_id, external_contact_id, channel, reason) do update
  set
    occurred_at = greatest(
      public.suppressions.occurred_at,
      excluded.occurred_at
    );
  
  end if;
  
  if p_table = 'engagement_events'
  and not exists (
    select
      1
    from
      public.campaigns
    where
      tenant_id = run.tenant_id
      and external_id = r ->> 'campaign_external_id'
  ) then
  insert into
    public.import_issues (
      tenant_id,
      import_id,
      row_number,
      severity,
      reason,
      external_id
    )
  values
    (
      run.tenant_id,
      run.id,
      source_row,
      'error',
      'Campaign reference missing; any valid contact suppression was retained',
      r ->> key_name
    );
  
  rejected := rejected + 1;
  
  continue;
  
  end if;
  
  execute format(
    'insert into public.%I select * from jsonb_populate_record(null::public.%I,$1) on conflict do nothing',
    p_table,
    p_table
  ) using r;
  
  end if;
  
  loaded := loaded + 1;
  
  exception when check_violation
  or foreign_key_violation
  or not_null_violation
  or invalid_text_representation
  or invalid_datetime_format
  or raise_exception then get stacked diagnostics failure_reason = message_text;
  
  insert into
    public.import_issues (
      tenant_id,
      import_id,
      row_number,
      severity,
      reason,
      external_id
    )
  values
    (
      run.tenant_id,
      run.id,
      source_row,
      'error',
      failure_reason,
      r ->> key_name
    );
  
  rejected := rejected + 1;
  
  end;
  
  end loop;
  
  return jsonb_build_object('loaded', loaded, 'rejected', rejected);
  
  end
$$;

revoke all on function public.import_row_batch (text, jsonb, uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.import_row_batch (text, jsonb, uuid) to service_role;

commit;
begin;

create function public.refresh_send_job (p_job uuid, p_lease uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
  declare pending integer;
  
  uncertain integer;
  
  failed integer;
  
  accepted integer;
  
  rejected integer;
  
  begin perform 1
  from
    public.send_jobs
  where
    id = p_job
    and lease_token = p_lease
  for update;
  
  if not found then raise exception 'Lease lost';
  
  end if;
  
  select
    count(*) filter (
      where
        b.status = 'pending'
    ),
    count(*) filter (
      where
        b.status = 'uncertain'
    ),
    count(*) filter (
      where
        b.status = 'failed'
    ),
    coalesce(sum(jsonb_array_length(b.accepted)), 0),
    coalesce(sum(jsonb_array_length(b.rejected)), 0) into pending,
    uncertain,
    failed,
    accepted,
    rejected
  from
    public.send_batches b
  where
    b.job_id = p_job;
  
  update public.send_jobs
  set
    status = case
      when failed > 0 then case
        when accepted > 0 then 'partial'
        else 'failed'
      end
      when uncertain > 0 then 'uncertain'
      when pending > 0 then 'queued'
      when rejected > 0 then 'partial'
      else 'accepted'
    end,
    accepted_count = accepted,
    rejected_count = rejected,
    updated_at = now(),
    lease_until = null,
    last_error = (
      select
        last_error
      from
        public.send_batches
      where
        job_id = p_job
        and last_error is not null
      order by
        batch_number
      limit
        1
    )
  where
    id = p_job;
  
  end
$$;

revoke all on function public.refresh_send_job (uuid, uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.refresh_send_job (uuid, uuid) to service_role;

commit;
begin;

alter table public.send_batches
add column attempted_at timestamptz;

alter table public.send_batches
add column attempts integer not null default 0;

alter table public.send_jobs
add column next_attempt_at timestamptz not null default now();

create or replace function public.claim_send_job () returns public.send_jobs language plpgsql security definer
set
  search_path = '' as $$
  declare j public.send_jobs;
  
  begin
  select
    * into j
  from
    public.send_jobs x
  where
    status in ('queued', 'sending', 'uncertain')
    and next_attempt_at <= now()
    and (
      lease_until is null
      or lease_until < now()
    )
    and not exists (
      select
        1
      from
        public.send_batches b
      where
        b.job_id = x.id
        and b.status = 'uncertain'
        and b.attempts >= 8
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

create function public.authorize_batch_attempt (p_batch uuid, p_lease uuid) returns boolean language plpgsql security definer
set
  search_path = '' as $$
  declare b public.send_batches;
  
  j public.send_jobs;
  
  a public.send_approvals;
  
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
  
  select
    * into j
  from
    public.send_jobs
  where
    id = b.job_id
    and lease_token = p_lease
    and lease_until > now()
  for update;
  
  if not found then raise exception 'Worker lease expired';
  
  end if;
  
  if b.status not in ('pending', 'uncertain')
  or b.attempts >= 8 then return false;
  
  end if;
  
  select
    * into a
  from
    public.send_approvals
  where
    id = j.approval_id;
  
  if b.attempted_at is null
  and exists (
    select
      1
    from
      jsonb_array_elements(b.recipients) r
      left join public.contacts c on c.tenant_id = b.tenant_id
      and c.external_id = r ->> 'external_id'
    where
      c.external_id is null
      or not public.is_contactable (c, a.channel)
      or r ->> 'destination' is distinct from case a.channel
        when 'email' then c.email
        else c.phone
      end
      or (
        a.target_country is not null
        and c.country is distinct from a.target_country
      )
  ) then
  update public.send_batches
  set
    status = 'failed',
    last_error = 'Eligibility changed before this batch was sent. Remaining unsent batches are stopped.'
  where
    job_id = j.id
    and attempted_at is null;
  
  return false;
  
  end if;
  
  -- Mark the attempt BEFORE the network call. A crash retries the same immutable payload/key.
  update public.send_batches
  set
    attempted_at = coalesce(attempted_at, now()),
    attempts = attempts + 1,
    status = 'uncertain'
  where
    id = b.id;
  
  update public.send_jobs
  set
    lease_until = now() + interval '2 minutes'
  where
    id = j.id;
  
  return true;
  
  end
$$;

create or replace function public.refresh_send_job (p_job uuid, p_lease uuid) returns void language plpgsql security definer
set
  search_path = '' as $$
  declare pending integer;
  
  uncertain integer;
  
  failed integer;
  
  accepted integer;
  
  rejected integer;
  
  max_attempts integer;
  
  begin perform 1
  from
    public.send_jobs
  where
    id = p_job
    and lease_token = p_lease
  for update;
  
  if not found then raise exception 'Lease lost';
  
  end if;
  
  select
    count(*) filter (
      where
        b.status = 'pending'
    ),
    count(*) filter (
      where
        b.status = 'uncertain'
    ),
    count(*) filter (
      where
        b.status = 'failed'
    ),
    coalesce(sum(jsonb_array_length(b.accepted)), 0),
    coalesce(sum(jsonb_array_length(b.rejected)), 0),
    coalesce(max(b.attempts), 0) into pending,
    uncertain,
    failed,
    accepted,
    rejected,
    max_attempts
  from
    public.send_batches b
  where
    b.job_id = p_job;
  
  update public.send_jobs
  set
    status = case
      when uncertain > 0 then 'uncertain'
      when failed > 0 then case
        when accepted > 0 then 'partial'
        else 'failed'
      end
      when pending > 0 then 'queued'
      when rejected > 0 then 'partial'
      else 'accepted'
    end,
    accepted_count = accepted,
    rejected_count = rejected,
    updated_at = now(),
    lease_until = null,
    next_attempt_at = case
      when uncertain > 0 then now() + make_interval(
        secs => least(3600, 15 * power(2, max_attempts))::int
      )
      else now()
    end,
    last_error = case
      when uncertain > 0
      and max_attempts >= 8 then 'Automatic retries stopped after eight attempts. Provider outcome requires investigation; do not create another send.'
      else (
        select
          last_error
        from
          public.send_batches
        where
          job_id = p_job
          and last_error is not null
        order by
          batch_number
        limit
          1
      )
    end
  where
    id = p_job;
  
  end
$$;

-- An export cannot silently restore a previous global opt-out or bounce.
create function public.record_contact_suppression () returns trigger language plpgsql security definer
set
  search_path = '' as $$
  begin if new.status in ('unsubscribed', 'bounced') then
  insert into
    public.suppressions (
      tenant_id,
      external_contact_id,
      channel,
      reason,
      occurred_at
    )
  select
    new.tenant_id,
    new.external_id,
    channel,
    case new.status
      when 'bounced' then 'bounce'
      else 'unsubscribe'
    end,
    new.source_version::timestamptz
  from
    unnest(array['email', 'sms']) channel
  on conflict (tenant_id, external_contact_id, channel, reason) do nothing;
  
  end if;
  
  return new;
  
  end
$$;

create trigger contact_suppression
after insert or update on public.contacts for each row
execute function public.record_contact_suppression ();

create function public.finish_import (p_import uuid, p_loaded integer) returns void language plpgsql security definer
set
  search_path = '' as $$
  begin
  update public.import_runs
  set
    status = 'completed',
    loaded_rows = p_loaded,
    rejected_rows = (
      select
        count(distinct row_number)
      from
        public.import_issues
      where
        import_id = p_import
        and severity = 'error'
    ),
    duplicate_rows = (
      select
        count(distinct row_number)
      from
        public.import_issues
      where
        import_id = p_import
        and severity = 'duplicate'
    ),
    warning_rows = (
      select
        count(distinct row_number)
      from
        public.import_issues
      where
        import_id = p_import
        and severity = 'warning'
    ),
    completed_at = now(),
    error_message = null
  where
    id = p_import;
  
  end
$$;

revoke all on function public.authorize_batch_attempt (uuid, uuid),
public.record_contact_suppression (),
public.finish_import (uuid, integer)
from
  public,
  anon,
  authenticated;

grant
execute on all functions in schema public to service_role;

commit;
begin;

create table public.destination_suppressions (
  tenant_id text not null references public.tenants,
  channel text not null check (channel in ('email', 'sms')),
  destination text not null,
  reason text not null check (reason in ('bounce', 'complaint', 'unsubscribe')),
  occurred_at timestamptz not null,
  primary key (tenant_id, channel, destination)
);

alter table public.destination_suppressions enable row level security;

revoke all on public.destination_suppressions
from
  anon,
  authenticated;

grant
select
  on public.destination_suppressions to authenticated;

grant all on public.destination_suppressions to service_role;

create policy tenant_read on public.destination_suppressions for
select
  to authenticated using (
    tenant_id = (
      select
        public.current_tenant ()
    )
  );

create function public.suppress_destination () returns trigger language plpgsql security definer
set
  search_path = '' as $$
  declare d text;
  
  begin
  select
    case new.channel
      when 'email' then email
      else phone
    end into d
  from
    public.contacts
  where
    tenant_id = new.tenant_id
    and external_id = new.external_contact_id;
  
  if d is not null then
  insert into
    public.destination_suppressions
  values
    (
      new.tenant_id,
      new.channel,
      d,
      new.reason,
      new.occurred_at
    )
  on conflict (tenant_id, channel, destination) do update
  set
    occurred_at = greatest(
      public.destination_suppressions.occurred_at,
      excluded.occurred_at
    );
  
  end if;
  
  return new;
  
  end
$$;

create trigger destination_suppression
after insert or update on public.suppressions for each row
execute function public.suppress_destination ();

create function public.suppress_provider_destination () returns trigger language plpgsql security definer
set
  search_path = '' as $$
  declare d text;
  
  ch text;
  
  begin if new.event_type not in ('bounced', 'unsubscribed') then return new;
  
  end if;
  
  select
    r ->> 'destination',
    a.channel into d,
    ch
  from
    public.send_batches b
    join public.send_jobs j on j.id = b.job_id
    join public.send_approvals a on a.id = j.approval_id
    cross join lateral jsonb_array_elements(b.recipients) r
  where
    b.id = new.batch_id
    and r ->> 'external_id' = new.external_contact_id;
  
  if d is not null then
  insert into
    public.destination_suppressions
  values
    (
      new.tenant_id,
      ch,
      d,
      case new.event_type
        when 'bounced' then 'bounce'
        else 'unsubscribe'
      end,
      new.occurred_at
    )
  on conflict (tenant_id, channel, destination) do update
  set
    occurred_at = greatest(
      public.destination_suppressions.occurred_at,
      excluded.occurred_at
    );
  
  end if;
  
  return new;
  
  end
$$;

create trigger provider_destination_suppression
after insert on public.provider_events for each row
execute function public.suppress_provider_destination ();

create or replace function public.is_contactable (
  c public.contacts,
  p_channel text,
  p_at timestamptz default now()
) returns boolean language sql stable security invoker
set
  search_path = '' as $$
  select
    c.status = 'active'
    and c.consent_marketing
    and c.deleted_at is null
    and (
      c.suppressed_until is null
      or c.suppressed_until <= p_at
    )
    and case p_channel
      when 'email' then c.email is not null
      when 'sms' then c.phone is not null
      else false
    end
    and not exists (
      select
        1
      from
        public.suppressions s
      where
        s.tenant_id = c.tenant_id
        and s.external_contact_id = c.external_id
        and s.channel = p_channel
    )
    and not exists (
      select
        1
      from
        public.destination_suppressions d
      where
        d.tenant_id = c.tenant_id
        and d.channel = p_channel
        and d.destination = case p_channel
          when 'email' then c.email
          else c.phone
        end
    )
$$;

create unique index approval_destination_unique on public.approval_recipients (tenant_id, approval_id, destination);

revoke all on function public.suppress_destination (),
public.suppress_provider_destination ()
from
  public,
  anon,
  authenticated;

grant
execute on all functions in schema public to service_role;

commit;
begin;

-- Evaluate suppressions as sets. The view preserves every underlying RLS policy.
create view public.contact_eligibility with (security_invoker = true) as
select c.*,
  coalesce(c.status = 'active' and c.consent_marketing and c.deleted_at is null
    and (c.suppressed_until is null or c.suppressed_until <= now())
    and c.email is not null and not coalesce(s.email_blocked, false)
    and e.destination is null, false) as email_contactable,
  coalesce(c.status = 'active' and c.consent_marketing and c.deleted_at is null
    and (c.suppressed_until is null or c.suppressed_until <= now())
    and c.phone is not null and not coalesce(s.sms_blocked, false)
    and p.destination is null, false) as sms_contactable
from public.contacts c
left join (
  select tenant_id, external_contact_id,
    bool_or(channel = 'email') as email_blocked,
    bool_or(channel = 'sms') as sms_blocked
  from public.suppressions
  group by tenant_id, external_contact_id
) s on s.tenant_id = c.tenant_id and s.external_contact_id = c.external_id
left join public.destination_suppressions e
  on e.tenant_id = c.tenant_id and e.channel = 'email' and e.destination = c.email
left join public.destination_suppressions p
  on p.tenant_id = c.tenant_id and p.channel = 'sms' and p.destination = c.phone;

revoke all on public.contact_eligibility from public, anon, authenticated;
grant select on public.contact_eligibility to authenticated, service_role;

create or replace function public.dashboard_metrics()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with audience as (
    select count(*) filter (where deleted_at is null) as customers,
      count(*) filter (where email_contactable or sms_contactable) as contactable,
      count(*) filter (where email_contactable) as email_contactable,
      count(*) filter (where sms_contactable) as sms_contactable
    from public.contact_eligibility
  ), context as (
    select id, timezone, (now() at time zone timezone)::date as today
    from public.tenants
  ), signups as (
    select (c.signup_at at time zone t.timezone)::date as day, count(*) as n
    from public.contacts c join context t on t.id = c.tenant_id
    where c.deleted_at is null
      and c.signup_at >= ((t.today - 29)::timestamp at time zone t.timezone)
      and c.signup_at < ((t.today + 1)::timestamp at time zone t.timezone)
    group by (c.signup_at at time zone t.timezone)::date
  ), days as (
    select t.today - g as day from context t cross join generate_series(0, 29) g
  )
  select to_jsonb(a) || jsonb_build_object(
    'campaigns', (select count(*) from public.campaigns),
    'signup_days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day,
      'count', coalesce(s.n, 0)) order by d.day), '[]'::jsonb)
      from days d left join signups s using (day)),
    'as_of', now())
  from audience a
$$;

create or replace function public.preview_campaign (p_campaign text) returns uuid language plpgsql security definer
set
  search_path = '' as $$
  declare t text := public.current_tenant ();
  
  c public.campaigns;
  
  a uuid;
  
  begin if not public.is_owner () then raise exception 'Only owners can prepare a send' using errcode = '42501';
  
  end if;
  
  select
    * into c
  from
    public.campaigns
  where
    tenant_id = t
    and external_id = p_campaign;
  
  if not found then raise exception 'Campaign not found';
  
  end if;
  
  if exists (
    select
      1
    from
      public.send_jobs
    where
      tenant_id = t
      and campaign_external_id = p_campaign
  ) then raise exception 'This campaign already has a send. Review its progress.';
  
  end if;
  
  insert into
    public.send_approvals (
      tenant_id,
      campaign_external_id,
      campaign_name,
      channel,
      target_country,
      created_by
    )
  values
    (
      t,
      c.external_id,
      c.campaign_name,
      c.channel,
      c.target_country,
      auth.uid ()
    )
  returning
    id into a;
  
  insert into
    public.approval_recipients (
      tenant_id,
      approval_id,
      external_contact_id,
      full_name,
      destination
    )
  select distinct
    on (
      case c.channel
        when 'email' then email
        else phone
      end
    ) t,
    a,
    external_id,
    full_name,
    case c.channel
      when 'email' then email
      else phone
    end
  from
    public.contact_eligibility x
  where
    x.tenant_id = t
    and (case c.channel when 'email' then x.email_contactable else x.sms_contactable end)
    and (
      c.target_country is null
      or x.country = c.target_country
    )
  order by
    case c.channel
      when 'email' then email
      else phone
    end,
    external_id;
  
  update public.send_approvals
  set
    recipient_count = (
      select
        count(*)
      from
        public.approval_recipients
      where
        tenant_id = t
        and approval_id = a
    )
  where
    id = a;
  
  return a;
  
  end
$$;

create or replace function public.confirm_campaign (p_approval uuid) returns uuid language plpgsql security definer
set
  search_path = '' as $$
  declare t text := public.current_tenant ();
  
  a public.send_approvals;
  
  j uuid;
  
  begin if not public.is_owner () then raise exception 'Only owners can send' using errcode = '42501';
  
  end if;
  
  select
    * into a
  from
    public.send_approvals
  where
    tenant_id = t
    and id = p_approval
  for update;
  
  if not found then raise exception 'Approval not found';
  
  end if;
  
  select
    id into j
  from
    public.send_jobs
  where
    approval_id = a.id;
  
  if found then return j;
  
  end if;
  
  if a.expires_at < now() then raise exception 'Preview expired. Review recipients again.';
  
  end if;
  
  if a.recipient_count = 0 then raise exception 'No contactable recipients';
  
  end if;
  
  -- Revalidate the entire snapshot before acceptance. Never silently replace it.
  if exists (
    select
      1
    from
      public.approval_recipients r
      join public.contact_eligibility c on (
        c.tenant_id = r.tenant_id
        and c.external_id = r.external_contact_id
      )
    where
      r.tenant_id = t
      and r.approval_id = a.id
      and (
        not (case a.channel when 'email' then c.email_contactable else c.sms_contactable end)
        or r.destination is distinct from case a.channel
          when 'email' then c.email
          else c.phone
        end
        or (
          a.target_country is not null
          and c.country is distinct from a.target_country
        )
      )
  ) then raise exception 'Audience changed. Review a fresh preview before confirming.';
  
  end if;
  
  insert into
    public.send_jobs (tenant_id, approval_id, campaign_external_id)
  values
    (t, a.id, a.campaign_external_id)
  on conflict (tenant_id, campaign_external_id) do nothing
  returning
    id into j;
  
  if j is null then raise exception 'This campaign already has a send. Review its progress.';
  
  end if;
  
  update public.send_approvals
  set
    approved_at = now(),
    approved_by = auth.uid ()
  where
    id = a.id;
  
  return j;
  
  end
$$;

create or replace function public.prepare_send_batches (p_job uuid, p_lease uuid) returns void language plpgsql security definer
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
      join public.contact_eligibility c on (
        c.tenant_id = r.tenant_id
        and c.external_id = r.external_contact_id
      )
    where
      r.approval_id = a.id
      and (
        not (case a.channel when 'email' then c.email_contactable else c.sms_contactable end)
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

commit;
-- Materialize only the requested page before evaluating expensive channel eligibility.
-- SECURITY INVOKER preserves caller RLS on both the count and page.
create or replace function public.contact_page(p_page integer default 0, p_search text default '')
returns jsonb language sql stable security invoker set search_path = '' as $$
  with page as materialized (
    select c.* from public.contacts c
    where c.deleted_at is null and (
      p_search = '' or c.full_name ilike '%' || left(p_search,100) || '%'
      or c.email ilike '%' || left(p_search,100) || '%'
    )
    order by c.full_name,c.external_id
    limit 50 offset greatest(0,least(p_page,100000))*50
  )
  select jsonb_build_object(
    'total',(select count(*) from public.contacts c where c.deleted_at is null and (
      p_search = '' or c.full_name ilike '%' || left(p_search,100) || '%'
      or c.email ilike '%' || left(p_search,100) || '%'
    )),
    'rows',coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
      'email_contactable',public.is_contactable(p::public.contacts,'email'),
      'sms_contactable',public.is_contactable(p::public.contacts,'sms')
    ) order by p.full_name,p.external_id) from page p),'[]'::jsonb)
  )
$$;
-- Avoid per-request JIT compilation overhead on the interactive dashboard.
-- This leaves query results, SECURITY INVOKER and RLS unchanged.
alter function public.dashboard_metrics() set jit = off;
