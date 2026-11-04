import {createHandler} from './wiki-submit.mjs';
import {createPublicReleaseVerifier} from './verify.mjs';
const secretKeys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const publishableKeys=Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}'));
Deno.serve(createHandler({url:Deno.env.get('SUPABASE_URL'),key:secretKeys.default,publishableKeys,verify:createPublicReleaseVerifier({enabled:Deno.env.get('WIKI_KONE_VERIFICATION_ENABLED')==='true'})}));
