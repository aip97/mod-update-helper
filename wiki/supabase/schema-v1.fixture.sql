-- Apply once through the project SQL Editor after reviewing this migration.
-- No service-role credentials or initial administrator are embedded here.
begin;

create table public.wiki_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.wiki_mods (
  mod_id text primary key,
  name text not null,
  post_url text not null,
  wml_versions text[] not null,
  game_spec text not null,
  description text not null,
  category text not null,
  version text not null,
  api_version text,
  package_sha256 text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wiki_submissions (
  id uuid primary key default gen_random_uuid(),
  mod_id text not null,
  name text not null,
  post_url text not null,
  wml_versions text[] not null,
  game_spec text not null,
  description text not null,
  category text not null,
  version text not null,
  api_version text,
  package_sha256 text,
  kind text not null check (kind in ('create','revision')),
  source text not null check (source in ('manual','detected')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  verification text not null check (verification in ('unverified','server_verified','manual_review')),
  api_verified boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  base_revision integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  review_note text
);
create unique index wiki_one_pending_per_mod on public.wiki_submissions (mod_id) where status = 'pending';

create table public.wiki_trusted_sources (
  mod_id text primary key,
  post_url text not null,
  version text not null,
  package_sha256 text not null,
  verified_by uuid not null references auth.users(id),
  verified_at timestamptz not null default now(),
  note text not null
);

create table public.wiki_audit_log (
  id bigint generated always as identity primary key,
  action text not null,
  actor uuid references auth.users(id),
  mod_id text not null,
  submission_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create table public.wiki_submission_limits (
  rate_key text not null,
  hour_start timestamptz not null,
  requests integer not null check (requests > 0),
  primary key (rate_key, hour_start)
);
create index wiki_submission_limits_expiry on public.wiki_submission_limits(hour_start);

alter table public.wiki_admins enable row level security;
alter table public.wiki_mods enable row level security;
alter table public.wiki_submissions enable row level security;
alter table public.wiki_trusted_sources enable row level security;
alter table public.wiki_audit_log enable row level security;
alter table public.wiki_submission_limits enable row level security;
revoke all on public.wiki_admins, public.wiki_mods, public.wiki_submissions,
  public.wiki_trusted_sources, public.wiki_audit_log, public.wiki_submission_limits from public, anon, authenticated;

create function public.wiki_is_admin() returns boolean
language sql stable security definer set search_path = pg_catalog
as $$ select exists (select 1 from public.wiki_admins where user_id = auth.uid()) $$;
revoke all on function public.wiki_is_admin() from public, anon, authenticated;
grant execute on function public.wiki_is_admin() to authenticated;

grant select on public.wiki_mods to anon, authenticated;
grant select on public.wiki_submissions, public.wiki_trusted_sources, public.wiki_audit_log to authenticated;
grant select on public.wiki_mods, public.wiki_submissions, public.wiki_trusted_sources to service_role;
create policy wiki_mods_public_read on public.wiki_mods for select to anon, authenticated using (true);
create policy wiki_submissions_admin_read on public.wiki_submissions for select to authenticated using (public.wiki_is_admin());
create policy wiki_sources_admin_read on public.wiki_trusted_sources for select to authenticated using (public.wiki_is_admin());
create policy wiki_audit_admin_read on public.wiki_audit_log for select to authenticated using (public.wiki_is_admin());

-- Match the updater's single-family game requirement grammar.
create function public.wiki_valid_game_spec(p_spec text) returns boolean
language plpgsql immutable set search_path = pg_catalog
as $$
declare part text; parts text[]; family text; found_family text; version text; d date;
begin
  if p_spec is null or char_length(p_spec)>128 then return false; end if;
  if btrim(p_spec)='' or btrim(p_spec)='*' then return true; end if;
  foreach part in array regexp_split_to_array(btrim(p_spec),'[[:space:]]+') loop
    parts := regexp_match(part,'^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(>=|<=|>|<|=)-?([0-9]+(?:[.][0-9]+)*)$');
    version := null;
    if parts is not null then
      found_family := parts[1]; version := parts[3];
    else
      parts := regexp_match(part,'^(>=|<=|>|<|=)?([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-([0-9]+(?:[.][0-9]+)*)$');
      if parts is not null then
        found_family := parts[2]; version := parts[3];
      else
        parts := regexp_match(part,'^(>=|<=|>|<|=)?([0-9]{4}-[0-9]{2}-[0-9]{2})(?:-([a-z][a-z0-9.]*))?$');
        if parts is not null then
          found_family := 'wayward';
          if substring(parts[2],1,4)::int < 1000 then return false; end if;
          begin
            d := make_date(substring(parts[2],1,4)::int,substring(parts[2],6,2)::int,substring(parts[2],9,2)::int);
          exception when others then return false; end;
        elsif part ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' then
          found_family := part;
        else return false; end if;
      end if;
    end if;
    if char_length(found_family)>64 or found_family='any' then return false; end if;
    if version is not null and (found_family='wayward' or char_length(found_family||'-'||version)>64
      or version !~ '^(0|[1-9][0-9]{0,5})([.](0|[1-9][0-9]{0,5}))*$') then return false; end if;
    if family is not null and family<>found_family then return false; end if;
    family := found_family;
  end loop;
  return true;
end $$;
revoke all on function public.wiki_valid_game_spec(text) from public, anon, authenticated;

-- This helper is not callable by API roles; all user strings remain data.
create function public.wiki_validate_payload(p_payload jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog
as $$
declare v jsonb; versions text[]; api text;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'WIKI_INVALID_PAYLOAD'; end if;
  if jsonb_typeof(p_payload->'wml_versions') is distinct from 'array'
     or jsonb_array_length(p_payload->'wml_versions') > 20 then raise exception 'WIKI_INVALID_WML'; end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'wml_versions') e where jsonb_typeof(e) <> 'string') then raise exception 'WIKI_INVALID_WML'; end if;
  select coalesce(array_agg(x),array[]::text[]) into versions from jsonb_array_elements_text(p_payload->'wml_versions') x;
  if exists (select 1 from unnest(versions) x where x !~ '^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})$')
     or (select count(distinct x) from unnest(versions) x) <> cardinality(versions) then raise exception 'WIKI_INVALID_WML'; end if;
  if jsonb_typeof(p_payload->'api_version') not in ('string','null') and p_payload ? 'api_version' then raise exception 'WIKI_INVALID_API_VERSION'; end if;
  api := nullif(btrim(p_payload->>'api_version'),'');
  if api is not null and api !~ '^[A-Za-z0-9._-]{1,32}$' then raise exception 'WIKI_INVALID_API_VERSION'; end if;
  if jsonb_typeof(p_payload->'mod_id') is distinct from 'string'
     or (p_payload->>'mod_id') !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or (p_payload->>'mod_id') ~ '[.]$'
     or (p_payload->>'mod_id') ~* '^(con|prn|aux|nul|com[0-9]|lpt[0-9])([.]|$)' then raise exception 'WIKI_INVALID_MOD_ID'; end if;
  if jsonb_typeof(p_payload->'post_url') is distinct from 'string'
     or (p_payload->>'post_url') !~ '^https://kone[.]gg/s/[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_-]{22}$' then raise exception 'WIKI_INVALID_POST_URL'; end if;
  if jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(btrim(p_payload->>'name')) not between 1 and 120
     or jsonb_typeof(p_payload->'description') is distinct from 'string' or char_length(btrim(p_payload->>'description')) not between 1 and 5000
     or jsonb_typeof(p_payload->'category') is distinct from 'string' or char_length(btrim(p_payload->>'category')) not between 1 and 60
     or jsonb_typeof(p_payload->'game_spec') is distinct from 'string' or char_length(btrim(p_payload->>'game_spec')) > 128
     or (cardinality(versions)=0 and btrim(p_payload->>'game_spec')='')
     or not public.wiki_valid_game_spec(p_payload->>'game_spec')
     or jsonb_typeof(p_payload->'version') is distinct from 'string' or (p_payload->>'version') !~ '^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})$'
     then raise exception 'WIKI_INVALID_FIELDS'; end if;
  v := jsonb_build_object('mod_id',p_payload->>'mod_id','name',btrim(p_payload->>'name'),
      'post_url',p_payload->>'post_url','wml_versions',to_jsonb(versions),'game_spec',btrim(p_payload->>'game_spec'),
      'description',btrim(p_payload->>'description'),'category',btrim(p_payload->>'category'),
      'version',p_payload->>'version','api_version',api);
  return v;
end $$;
revoke all on function public.wiki_validate_payload(jsonb) from public, anon, authenticated;

-- Reserve before any network or ZIP work. Never accept this key directly from a browser.
create function public.wiki_reserve_quota(p_rate_key text) returns boolean
language plpgsql security definer set search_path = pg_catalog
as $$
declare n integer; bucket timestamptz := date_trunc('hour',now());
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501', message='WIKI_SERVICE_REQUIRED'; end if;
  if p_rate_key is null or p_rate_key !~ '^[a-f0-9]{64}$' or p_rate_key=repeat('0',64) then raise exception 'WIKI_INVALID_RATE_KEY'; end if;
  delete from public.wiki_submission_limits where hour_start < bucket - interval '24 hours';
  insert into public.wiki_submission_limits(rate_key,hour_start,requests) values(p_rate_key,bucket,1)
    on conflict (rate_key,hour_start) do update set requests=public.wiki_submission_limits.requests+1
      where public.wiki_submission_limits.requests < 5 returning requests into n;
  if n is null then raise exception 'WIKI_RATE_LIMIT'; end if;
  n := null;
  insert into public.wiki_submission_limits(rate_key,hour_start,requests) values(repeat('0',64),bucket,1)
    on conflict (rate_key,hour_start) do update set requests=public.wiki_submission_limits.requests+1
      where public.wiki_submission_limits.requests < 300 returning requests into n;
  if n is null then raise exception 'WIKI_RATE_LIMIT'; end if;
  return true;
end $$;
revoke all on function public.wiki_reserve_quota(text) from public, anon, authenticated;
grant execute on function public.wiki_reserve_quota(text) to service_role;

-- The edge verifier must compute the rate key server-side, not accept it from a browser.
create function public.wiki_create_submission(p_payload jsonb, p_kind text, p_source text, p_verification text, p_api_verified boolean, p_package_sha256 text, p_rate_key text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare v jsonb; s public.wiki_submissions%rowtype; base integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501', message='WIKI_SERVICE_REQUIRED'; end if;
  if p_kind not in ('create','revision') or p_kind is null
     or p_source not in ('manual','detected') or p_source is null
     or p_verification not in ('server_verified','manual_review') or p_verification is null
     or p_api_verified is null or (p_verification <> 'server_verified' and p_api_verified)
     or (p_source='detected' and (p_verification <> 'server_verified' or not p_api_verified))
     or (p_verification='server_verified' and (p_package_sha256 is null or p_package_sha256 !~ '^[a-f0-9]{64}$'))
     or (p_verification='manual_review' and p_package_sha256 is not null)
     or p_rate_key is null or p_rate_key !~ '^[a-f0-9]{64}$' then raise exception 'WIKI_INVALID_SUBMISSION'; end if;
  v := public.wiki_validate_payload(p_payload);
  -- Serialize queue admission so concurrent requests cannot exceed the bound.
  perform pg_advisory_xact_lock(728114603221::bigint);
  if (select count(*) from public.wiki_submissions where status='pending') >= 500 then raise exception 'WIKI_QUEUE_FULL'; end if;
  select revision into base from public.wiki_mods where mod_id=v->>'mod_id' for update;
  if p_kind='create' and base is not null then raise exception 'WIKI_ALREADY_PUBLISHED'; end if;
  if p_kind='revision' and base is null then raise exception 'WIKI_NOT_FOUND'; end if;
  insert into public.wiki_submissions(mod_id,name,post_url,wml_versions,game_spec,description,category,version,api_version,package_sha256,kind,source,verification,api_verified,base_revision)
  values(v->>'mod_id',v->>'name',v->>'post_url',array(select jsonb_array_elements_text(v->'wml_versions')),
    v->>'game_spec',v->>'description',v->>'category',v->>'version',v->>'api_version',p_package_sha256,p_kind,p_source,p_verification,p_api_verified,base)
  returning * into s;
  return jsonb_build_object('id',s.id,'status',s.status,'revision',s.revision,'verification',s.verification);
end $$;
revoke all on function public.wiki_create_submission(jsonb,text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.wiki_create_submission(jsonb,text,text,text,boolean,text,text) to service_role;

create function public.wiki_set_trusted_source(p_mod_id text, p_post_url text, p_version text, p_package_sha256 text, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare before_row jsonb; result public.wiki_trusted_sources%rowtype; candidate public.wiki_submissions%rowtype;
begin
  if not public.wiki_is_admin() then raise exception using errcode='42501', message='WIKI_ADMIN_REQUIRED'; end if;
  if p_mod_id is null or p_mod_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or p_mod_id ~ '[.]$'
     or p_post_url is null or p_post_url !~ '^https://kone[.]gg/s/[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_-]{22}$'
     or p_mod_id ~* '^(con|prn|aux|nul|com[0-9]|lpt[0-9])([.]|$)'
     or p_version is null or p_version !~ '^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})$'
     or p_package_sha256 is null or p_package_sha256 !~ '^[a-f0-9]{64}$'
     or p_note is null or char_length(btrim(p_note)) not between 1 and 1000 then raise exception 'WIKI_INVALID_SOURCE'; end if;
  select to_jsonb(t) into before_row from public.wiki_trusted_sources t where mod_id=p_mod_id for update;
  insert into public.wiki_trusted_sources(mod_id,post_url,version,package_sha256,verified_by,verified_at,note)
    values(p_mod_id,p_post_url,p_version,p_package_sha256,auth.uid(),now(),btrim(p_note))
    on conflict (mod_id) do update set post_url=excluded.post_url, version=excluded.version, package_sha256=excluded.package_sha256, verified_by=excluded.verified_by, verified_at=excluded.verified_at, note=excluded.note
    returning * into result;
  insert into public.wiki_audit_log(action,actor,mod_id,before_data,after_data) values('trust_source',auth.uid(),p_mod_id,before_row,to_jsonb(result));
  select s.* into candidate from public.wiki_submissions s
    where s.mod_id=p_mod_id and s.post_url=p_post_url and s.version=p_version and s.package_sha256=p_package_sha256
      and s.status='pending' and s.kind='create' and s.source='detected'
      and s.verification='server_verified' and s.api_verified and s.api_version is not null
    for update;
  if found then perform public.wiki_publish_submission(candidate.id,candidate.revision,auth.uid(),'verified trusted source'); end if;
  return to_jsonb(result);
end $$;
revoke all on function public.wiki_set_trusted_source(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.wiki_set_trusted_source(text,text,text,text,text) to authenticated;

create function public.wiki_remove_trusted_source(p_mod_id text, p_note text)
returns boolean language plpgsql security definer set search_path = pg_catalog
as $$
declare old_row jsonb;
begin
  if not public.wiki_is_admin() then raise exception using errcode='42501', message='WIKI_ADMIN_REQUIRED'; end if;
  if p_note is null or char_length(btrim(p_note)) not between 1 and 1000 then raise exception 'WIKI_INVALID_SOURCE'; end if;
  delete from public.wiki_trusted_sources as t where t.mod_id=p_mod_id returning to_jsonb(t) into old_row;
  if old_row is null then raise exception 'WIKI_NOT_FOUND'; end if;
  insert into public.wiki_audit_log(action,actor,mod_id,before_data,after_data)
    values('remove_trusted_source',auth.uid(),p_mod_id,old_row,jsonb_build_object('note',btrim(p_note)));
  return true;
end $$;
revoke all on function public.wiki_remove_trusted_source(text,text) from public, anon, authenticated;
grant execute on function public.wiki_remove_trusted_source(text,text) to authenticated;

-- This helper is callable only from the two authorization-checked functions below.
create function public.wiki_publish_submission(p_id uuid, p_expected_revision integer, p_actor uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare s public.wiki_submissions%rowtype; old_mod public.wiki_mods%rowtype; new_mod public.wiki_mods%rowtype; had_mod boolean;
begin
  select * into s from public.wiki_submissions where id=p_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if s.status <> 'pending' then raise exception 'WIKI_SUBMISSION_CLOSED'; end if;
  if p_expected_revision is null or s.revision <> p_expected_revision then raise exception 'WIKI_REVISION_CONFLICT'; end if;
  if s.verification not in ('server_verified','manual_review') then raise exception 'WIKI_DIAGNOSTICS_REQUIRED'; end if;
  if s.verification='manual_review' and (p_actor is null or coalesce(char_length(btrim(p_note)),0)=0) then
    raise exception 'WIKI_REVIEW_NOTE_REQUIRED';
  end if;
  select * into old_mod from public.wiki_mods where mod_id=s.mod_id for update;
  had_mod := found;
  if (s.kind='create' and had_mod) or (s.kind='revision' and (not had_mod or old_mod.revision is distinct from s.base_revision)) then
    raise exception 'WIKI_REVISION_CONFLICT';
  end if;
  if s.kind='create' then
    begin
      insert into public.wiki_mods(mod_id,name,post_url,wml_versions,game_spec,description,category,version,api_version,package_sha256)
      values(s.mod_id,s.name,s.post_url,s.wml_versions,s.game_spec,s.description,s.category,s.version,s.api_version,s.package_sha256) returning * into new_mod;
    exception when unique_violation then raise exception 'WIKI_REVISION_CONFLICT'; end;
  else
    update public.wiki_mods set name=s.name,post_url=s.post_url,wml_versions=s.wml_versions,game_spec=s.game_spec,
      description=s.description,category=s.category,version=s.version,api_version=s.api_version,package_sha256=s.package_sha256,
      revision=revision+1,updated_at=now() where mod_id=s.mod_id returning * into new_mod;
  end if;
  update public.wiki_submissions set status='approved',revision=revision+1,updated_at=now(),reviewed_at=now(),
    reviewed_by=p_actor,review_note=p_note where id=s.id returning * into s;
  insert into public.wiki_audit_log(action,actor,mod_id,submission_id,before_data,after_data)
    values('approve',p_actor,s.mod_id,s.id,case when had_mod then to_jsonb(old_mod) else null end,to_jsonb(new_mod));
  return to_jsonb(s);
end $$;
revoke all on function public.wiki_publish_submission(uuid,integer,uuid,text) from public, anon, authenticated, service_role;

create function public.wiki_review(p_submission_id uuid, p_expected_revision integer, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare s public.wiki_submissions%rowtype; old_row jsonb;
begin
  if not public.wiki_is_admin() then raise exception using errcode='42501', message='WIKI_ADMIN_REQUIRED'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') or coalesce(char_length(p_note),0)>1000 then raise exception 'WIKI_INVALID_DECISION'; end if;
  if p_decision='approved' then return public.wiki_publish_submission(p_submission_id,p_expected_revision,auth.uid(),p_note); end if;
  select * into s from public.wiki_submissions where id=p_submission_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if s.status <> 'pending' then raise exception 'WIKI_SUBMISSION_CLOSED'; end if;
  if p_expected_revision is null or s.revision <> p_expected_revision then raise exception 'WIKI_REVISION_CONFLICT'; end if;
  old_row := to_jsonb(s);
  update public.wiki_submissions set status='rejected',revision=revision+1,updated_at=now(),reviewed_at=now(),
    reviewed_by=auth.uid(),review_note=p_note where id=s.id returning * into s;
  insert into public.wiki_audit_log(action,actor,mod_id,submission_id,before_data,after_data)
    values('reject',auth.uid(),s.mod_id,s.id,old_row,to_jsonb(s));
  return to_jsonb(s);
end $$;
revoke all on function public.wiki_review(uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.wiki_review(uuid,integer,text,text) to authenticated;

create function public.wiki_auto_publish(p_submission_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog
as $$
declare s public.wiki_submissions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501', message='WIKI_SERVICE_REQUIRED'; end if;
  select * into s from public.wiki_submissions where id=p_submission_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if s.status <> 'pending' then raise exception 'WIKI_SUBMISSION_CLOSED'; end if;
  if s.kind <> 'create' or s.source <> 'detected' or s.verification <> 'server_verified' or not s.api_verified or s.api_version is null
     or not exists(select 1 from public.wiki_trusted_sources t where t.mod_id=s.mod_id and t.post_url=s.post_url and t.version=s.version and t.package_sha256=s.package_sha256)
     then raise exception 'WIKI_AUTO_APPROVAL_DENIED'; end if;
  return public.wiki_publish_submission(s.id,s.revision,null,'verified trusted source');
end $$;
revoke all on function public.wiki_auto_publish(uuid) from public, anon, authenticated;
grant execute on function public.wiki_auto_publish(uuid) to service_role;

create function public.wiki_edit_submission(p_submission_id uuid, p_expected_revision integer, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare s public.wiki_submissions%rowtype; v jsonb; old_row jsonb; changed boolean;
begin
  if not public.wiki_is_admin() then raise exception using errcode='42501', message='WIKI_ADMIN_REQUIRED'; end if;
  select * into s from public.wiki_submissions where id=p_submission_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if s.status <> 'pending' then raise exception 'WIKI_SUBMISSION_CLOSED'; end if;
  if p_expected_revision is null or s.revision <> p_expected_revision then raise exception 'WIKI_REVISION_CONFLICT'; end if;
  v := public.wiki_validate_payload(p_payload || jsonb_build_object('mod_id',s.mod_id));
  changed := s.post_url is distinct from v->>'post_url' or s.version is distinct from v->>'version'
    or s.api_version is distinct from v->>'api_version' or s.game_spec is distinct from v->>'game_spec'
    or s.wml_versions is distinct from array(select jsonb_array_elements_text(v->'wml_versions'));
  old_row := to_jsonb(s);
  update public.wiki_submissions set name=v->>'name',post_url=v->>'post_url',
    wml_versions=array(select jsonb_array_elements_text(v->'wml_versions')),game_spec=v->>'game_spec',
    description=v->>'description',category=v->>'category',version=v->>'version',api_version=v->>'api_version',
    verification=case when changed then 'unverified' else verification end,
    api_verified=case when changed then false else api_verified end,
    package_sha256=case when changed then null else package_sha256 end,source='manual',revision=revision+1,updated_at=now()
    where id=s.id returning * into s;
  insert into public.wiki_audit_log(action,actor,mod_id,submission_id,before_data,after_data)
    values('edit_submission',auth.uid(),s.mod_id,s.id,old_row,to_jsonb(s));
  return to_jsonb(s);
end $$;
revoke all on function public.wiki_edit_submission(uuid,integer,jsonb) from public, anon, authenticated;
grant execute on function public.wiki_edit_submission(uuid,integer,jsonb) to authenticated;

-- Revalidation can only be recorded by the server after inspecting the current revision.
create function public.wiki_set_verification(p_submission_id uuid, p_expected_revision integer, p_verification text, p_api_verified boolean, p_package_sha256 text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare s public.wiki_submissions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode='42501', message='WIKI_SERVICE_REQUIRED'; end if;
  if p_verification not in ('server_verified','manual_review') or p_verification is null or p_api_verified is null
     or (p_verification <> 'server_verified' and p_api_verified)
     or (p_verification='server_verified' and (p_package_sha256 is null or p_package_sha256 !~ '^[a-f0-9]{64}$'))
     or (p_verification='manual_review' and p_package_sha256 is not null) then raise exception 'WIKI_INVALID_SUBMISSION'; end if;
  select * into s from public.wiki_submissions where id=p_submission_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if s.status <> 'pending' then raise exception 'WIKI_SUBMISSION_CLOSED'; end if;
  if p_expected_revision is null or s.revision <> p_expected_revision then raise exception 'WIKI_REVISION_CONFLICT'; end if;
  update public.wiki_submissions set verification=p_verification,api_verified=p_api_verified,package_sha256=p_package_sha256,revision=revision+1,updated_at=now()
    where id=s.id returning * into s;
  return to_jsonb(s);
end $$;
revoke all on function public.wiki_set_verification(uuid,integer,text,boolean,text) from public, anon, authenticated;
grant execute on function public.wiki_set_verification(uuid,integer,text,boolean,text) to service_role;

create function public.wiki_mark_manual_review(p_submission_id uuid, p_expected_revision integer, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare s public.wiki_submissions%rowtype; old_row jsonb;
begin
  if not public.wiki_is_admin() then raise exception using errcode='42501', message='WIKI_ADMIN_REQUIRED'; end if;
  if p_note is null or char_length(btrim(p_note)) not between 1 and 1000 then raise exception 'WIKI_REVIEW_NOTE_REQUIRED'; end if;
  select * into s from public.wiki_submissions where id=p_submission_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if s.status <> 'pending' then raise exception 'WIKI_SUBMISSION_CLOSED'; end if;
  if p_expected_revision is null or s.revision <> p_expected_revision then raise exception 'WIKI_REVISION_CONFLICT'; end if;
  old_row := to_jsonb(s);
  update public.wiki_submissions set verification='manual_review',api_verified=false,package_sha256=null,review_note=btrim(p_note),
    revision=revision+1,updated_at=now() where id=s.id returning * into s;
  insert into public.wiki_audit_log(action,actor,mod_id,submission_id,before_data,after_data)
    values('manual_review',auth.uid(),s.mod_id,s.id,old_row,to_jsonb(s));
  return to_jsonb(s);
end $$;
revoke all on function public.wiki_mark_manual_review(uuid,integer,text) from public, anon, authenticated;
grant execute on function public.wiki_mark_manual_review(uuid,integer,text) to authenticated;

create function public.wiki_edit_mod(p_mod_id text, p_expected_revision integer, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog
as $$
declare m public.wiki_mods%rowtype; v jsonb; old_row jsonb; changed boolean;
begin
  if not public.wiki_is_admin() then raise exception using errcode='42501', message='WIKI_ADMIN_REQUIRED'; end if;
  select * into m from public.wiki_mods where mod_id=p_mod_id for update;
  if not found then raise exception 'WIKI_NOT_FOUND'; end if;
  if p_expected_revision is null or m.revision <> p_expected_revision then raise exception 'WIKI_REVISION_CONFLICT'; end if;
  v := public.wiki_validate_payload(p_payload || jsonb_build_object('mod_id',m.mod_id));
  changed := m.post_url is distinct from v->>'post_url' or m.version is distinct from v->>'version'
    or m.api_version is distinct from v->>'api_version' or m.game_spec is distinct from v->>'game_spec'
    or m.wml_versions is distinct from array(select jsonb_array_elements_text(v->'wml_versions'));
  old_row := to_jsonb(m);
  update public.wiki_mods set name=v->>'name',post_url=v->>'post_url',
    wml_versions=array(select jsonb_array_elements_text(v->'wml_versions')),game_spec=v->>'game_spec',
    description=v->>'description',category=v->>'category',version=v->>'version',api_version=v->>'api_version',
    package_sha256=case when changed then null else package_sha256 end,
    revision=revision+1,updated_at=now() where mod_id=m.mod_id returning * into m;
  insert into public.wiki_audit_log(action,actor,mod_id,before_data,after_data)
    values('edit_mod',auth.uid(),m.mod_id,old_row,to_jsonb(m));
  return to_jsonb(m);
end $$;
revoke all on function public.wiki_edit_mod(text,integer,jsonb) from public, anon, authenticated;
grant execute on function public.wiki_edit_mod(text,integer,jsonb) to authenticated;

commit;


