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
