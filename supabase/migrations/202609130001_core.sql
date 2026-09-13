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
