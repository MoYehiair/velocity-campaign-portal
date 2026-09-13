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
