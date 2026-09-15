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
