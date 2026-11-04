import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../../test-output/wiki-pg/node_modules/@electric-sql/pglite/dist/index.js';

const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role' $$;`);
await db.exec(await readFile(new URL('./schema-v1.fixture.sql',import.meta.url),'utf8'));
const admin='00000000-0000-0000-0000-000000000001';
await db.query('insert into auth.users(id) values ($1)',[admin]);
await db.query('insert into public.wiki_admins(user_id) values($1)',[admin]);
const post='https://kone.gg/s/space/abcdefghijklmnopqrstuv', hash='a'.repeat(64);
await db.query(`insert into public.wiki_mods(mod_id,name,post_url,wml_versions,game_spec,description,category,version,package_sha256)
  values('same-id','Original',$1,array['0.9.5'],'faith>=3.0','Existing','utility','1.0.0',$2)`,[post,hash]);
await db.query(`insert into public.wiki_submissions(mod_id,name,post_url,wml_versions,game_spec,description,category,version,kind,source,verification)
  values('pending-mod','Pending',$1,array['0.9.5'],'overtime>=1.0','Pending','utility','1.0.0','create','manual','manual_review')`,[post]);
await db.query(`insert into public.wiki_trusted_sources(mod_id,post_url,version,package_sha256,verified_by,note)
  values('same-id',$1,'1.0.0',$2,$3,'known'),('unresolved-id',$1,'1.0.0',$2,$3,'unknown')`,[post,hash,admin]);
await db.query(`insert into public.wiki_audit_log(action,actor,mod_id,after_data)
  values('edit_mod',$1,'same-id','{"game_spec":"faith>=3.0"}'::jsonb)`,[admin]);
const before={};
for (const table of ['wiki_mods','wiki_submissions','wiki_trusted_sources','wiki_audit_log'])
  before[table]=(await db.query(`select * from public.${table} order by mod_id`)).rows;
await db.exec(await readFile(new URL('./game-family-migration.sql',import.meta.url),'utf8'));
const row=async(sql,args=[]) => (await db.query(sql,args)).rows;
for (const table of Object.keys(before)) {
  const after=(await row(`select * from public.${table} order by mod_id`)).map(({game_family,...rest})=>rest);
  assert.deepEqual(after,before[table],`existing ${table} changed`);
}
assert.deepEqual(await row('select mod_id,game_family,description from public.wiki_mods'),[{mod_id:'same-id',game_family:'faith',description:'Existing'}]);
assert.equal((await row("select game_family from public.wiki_submissions where mod_id='pending-mod'"))[0].game_family,'overtime');
assert.deepEqual(await row('select mod_id,game_family from public.wiki_trusted_sources order by mod_id'),
  [{mod_id:'same-id',game_family:'faith'},{mod_id:'unresolved-id',game_family:'__legacy_unresolved'}]);
assert.equal((await row('select game_family from public.wiki_audit_log'))[0].game_family,'faith');
const role=async(name,id)=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:name,...id?{sub:id}:{}})]);await db.exec('set role '+name)};
const call=async(name,args)=>(await row(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args))[0].value;
await role('service_role');
const payload={mod_id:'same-id',name:'Wayward',post_url:post,wml_versions:['0.9.5'],game_spec:'',description:'Wayward only',category:'utility',version:'1.0.0',api_version:null};
await assert.rejects(()=>call('wiki_create_submission',[{...payload,mod_id:'unresolved-id',game_spec:'__legacy_unresolved'},'create','manual','manual_review',false,null,'b'.repeat(64)]),/WIKI_INVALID_FIELDS/);
const unrelated=await call('wiki_create_submission',[{...payload,mod_id:'unresolved-id',game_spec:'legacy',api_version:'2'},'create','detected','server_verified',true,hash,'b'.repeat(64)]);
await assert.rejects(()=>call('wiki_auto_publish',[unrelated.id]),/WIKI_AUTO_APPROVAL_DENIED/);
const sub=await call('wiki_create_submission',[payload,'create','manual','manual_review',false,null,'b'.repeat(64)]);
await role('authenticated',admin);
await call('wiki_review',[sub.id,sub.revision,'approved','checked']);
await assert.rejects(()=>call('wiki_edit_mod',['same-id',1,payload]),/WIKI_AMBIGUOUS_MOD/);
await role('anon');
assert.equal((await row("select count(*)::int n from public.wiki_mods where mod_id='same-id'"))[0].n,2);
await assert.rejects(()=>row('select * from public.wiki_submissions'),/permission denied/i);
await assert.rejects(()=>call('wiki_edit_mod',['same-id',1,payload,'wayward']),/permission denied/i);
await db.close();
console.log('Legacy migration: existing entries, isolated family, trust isolation, audit and RLS passed.');
