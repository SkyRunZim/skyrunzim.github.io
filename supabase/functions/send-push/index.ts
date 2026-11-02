// send-push: tells runners' phones there is a new message from race control.
// Called by the dashboard right after an organiser posts a message.
//
// Deploy: Supabase > Edge Functions > Deploy a new function > Via Editor,
// name it send-push, paste this whole file, Deploy. Then in its Details,
// turn OFF "Verify JWT" (this function checks the organiser itself).
// Secret needed (Edge Functions > Secrets): VAPID_PRIVATE_JWK.
//
// The notification carries no text: the phone wakes up, collects the message
// from get_messages itself and shows it. So message text never passes
// through Apple's or Google's push services, and nothing needs encrypting.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const SUBJECT = 'mailto:wildnyanga@farandwide.co.zw';   // who push services contact about problems
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// --- vapid ---
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const text = s => new TextEncoder().encode(s);

// The private key (a JSON Web Key) and the matching public key the phones subscribed with.
async function loadVapid(jwkJson) {
  const jwk = JSON.parse(jwkJson);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pub = b64url(new Uint8Array([4, ...fromB64url(jwk.x), ...fromB64url(jwk.y)]));
  return { key, pub, tokens: new Map() };
}

// A signed token for one push service (Google, Apple, Mozilla...), valid 12 hours.
async function vapidHeader(v, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  if (!v.tokens.has(aud)) {
    const head = b64url(text(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const body = b64url(text(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, text(`${head}.${body}`));
    v.tokens.set(aud, `vapid t=${head}.${body}.${b64url(sig)}, k=${v.pub}`);
  }
  return v.tokens.get(aud);
}

// An empty push: "wake up, there is news". Kept by the push service for a day
// if the phone has no signal.
async function sendPush(v, endpoint, subject) {
  return fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(v, endpoint, subject), TTL: '86400', Urgency: 'high' },
    body: new Uint8Array(0),   // an empty body, sent with Content-Length: 0
  });
}
// --- end vapid ---

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));

    // Organisers only: the caller's login must be on the organisers list.
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who, error: authErr } = await admin.auth.getUser(jwt);
    if (authErr || !who.user) return json({ error: `Could not check the organiser login: ${authErr ? authErr.message : 'no user'}` }, 403);
    const email = (who.user.email || '').toLowerCase();
    const { data: org } = await admin.from('organisers').select('email').eq('email', email).maybeSingle();
    if (!org) return json({ error: `Organisers only (${email} is not on the organisers list)` }, 403);

    // The secret key, pasted into Edge Functions > Secrets.
    const raw = (Deno.env.get('VAPID_PRIVATE_JWK') || '').trim().replace(/^['"](\{.*\})['"]$/, '$1');
    if (!raw) return json({ error: 'The VAPID_PRIVATE_JWK secret is missing: add it in Edge Functions > Secrets' }, 500);
    let v;
    try { v = await loadVapid(raw); }
    catch (err) { return json({ error: `The VAPID_PRIVATE_JWK secret is not right (${err.message}): paste the whole line starting { and ending }` }, 500); }

    const { message_id } = await req.json();
    const { data: msg, error } = await admin.from('messages').select('id, race_id').eq('id', message_id).single();
    if (error) return json({ error: `Message ${message_id} not found` }, 404);

    let q = admin.from('push_subscriptions').select('device_id, endpoint');
    if (msg.race_id) q = q.eq('race_id', msg.race_id);
    const { data: subs, error: subErr } = await q;
    if (subErr) return json({ error: `Could not read the phones list: ${subErr.message}` }, 500);

    let sent = 0, failed = 0, why = '';
    const gone = [];
    await Promise.all((subs || []).map(async s => {
      try {
        const res = await sendPush(v, s.endpoint, SUBJECT);
        if (res.status === 404 || res.status === 410) gone.push(s.device_id);   // phone unsubscribed or app removed
        else if (res.ok) sent++;
        else { failed++; why ||= `${new URL(s.endpoint).host} said ${res.status} ${(await res.text()).slice(0, 160)}`; }
      } catch (err) { failed++; why ||= `${new URL(s.endpoint).host}: ${String(err).slice(0, 160)}`; }
    }));
    if (gone.length) await admin.from('push_subscriptions').delete().in('device_id', gone);
    return json({ sent, failed, removed: gone.length, phones: (subs || []).length, why });
  } catch (err) {
    return json({ error: String(err && err.message || err) }, 500);
  }
});
