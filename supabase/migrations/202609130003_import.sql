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
