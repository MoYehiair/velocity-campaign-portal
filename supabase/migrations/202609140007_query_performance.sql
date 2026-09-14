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
