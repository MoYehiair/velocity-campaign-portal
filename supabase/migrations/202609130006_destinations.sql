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
