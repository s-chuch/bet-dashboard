// Edge Function read-slip: reads a bet-slip screenshot with Gemini in the background.
// POST {job_id, prompt} with Authorization: Bearer <user access token>  ->  202 {ok:true} at once.
// Then (EdgeRuntime.waitUntil) the job goes queued -> reading -> done|error, and the image is always deleted.
// Secrets (Supabase secrets, never in the repo): GEMINI_API_KEY; optional READ_SLIP_MODELS.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { geminiText, isRetryableStatus, parseModels, readWithFallback } from './logic.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const BUCKET = 'slips';
const MODEL_TIMEOUT_MS = 45_000;
const MAX_PROMPT = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function corsFor(origin: string | null): Record<string, string> {
  const ok = !!origin && (origin === 'https://s-chuch.github.io' || /^http:\/\/localhost(:\d+)?$/.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin! : 'https://s-chuch.github.io',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function callGemini(model: string, key: string, prompt: string, mime: string, data: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    await res.body?.cancel();
    // 429/5xx are "try the next model"; other statuses are too (a different model may still work).
    throw new Error(isRetryableStatus(res.status) ? `model busy (HTTP ${res.status})` : `model refused (HTTP ${res.status})`);
  }
  const text = geminiText(await res.json());
  if (!text) throw new Error('empty reply');
  return text;
}

async function work(admin: ReturnType<typeof createClient>, jobId: string, path: string, prompt: string) {
  const fail = (msg: string) => admin.from('slip_jobs').update({ status: 'error', error: msg }).eq('id', jobId);
  try {
    await admin.from('slip_jobs').update({ status: 'reading' }).eq('id', jobId);
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) { await fail('Reading is not configured on the server.'); return; }

    const dl = await admin.storage.from(BUCKET).download(path);
    if (dl.error || !dl.data) { await fail('The screenshot could not be found. Please upload it again.'); return; }
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const mime = MIME[ext] || (dl.data.type && dl.data.type.startsWith('image/') ? dl.data.type : 'image/jpeg');
    const data = toBase64(bytes);

    const models = parseModels(Deno.env.get('READ_SLIP_MODELS'));
    const out = await readWithFallback(models, (m) => callGemini(m, key, prompt, mime, data));
    if (out.ok) await admin.from('slip_jobs').update({ status: 'done', result: out.rows, error: null }).eq('id', jobId);
    else await fail(out.error);
  } catch (_e) {
    // never log the error object: it could carry request details
    await fail('Reading failed unexpectedly. Please try again.');
  } finally {
    try { await admin.storage.from(BUCKET).remove([path]); } catch (_e) { /* ignore */ }
  }
}

Deno.serve(async (req: Request) => {
  const cors = corsFor(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405, cors);

  let body: { job_id?: unknown; prompt?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400, cors); }
  const jobId = body.job_id, prompt = body.prompt;
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return json({ ok: false, error: 'bad job_id' }, 400, cors);
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) return json({ ok: false, error: 'bad prompt' }, 400, cors);

  const url = Deno.env.get('SUPABASE_URL')!;
  const auth = req.headers.get('authorization') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: ue } = await userClient.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
  if (ue || !u?.user) return json({ ok: false, error: 'not signed in' }, 401, cors);

  // RLS proves ownership: the user client only sees the caller's own rows.
  const { data: job } = await userClient.from('slip_jobs').select('id,user_id,path,status').eq('id', jobId).maybeSingle();
  if (!job) return json({ ok: false, error: 'job not found' }, 404, cors);
  if (job.status !== 'queued') return json({ ok: false, error: 'job already started' }, 409, cors);
  if (job.user_id !== u.user.id || typeof job.path !== 'string' || !job.path.startsWith(job.user_id + '/') || job.path.includes('..')) {
    return json({ ok: false, error: 'bad path' }, 400, cors);
  }

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  // Claim the job atomically so a double call cannot run twice.
  const { data: claimed } = await admin.from('slip_jobs').update({ status: 'reading' }).eq('id', jobId).eq('status', 'queued').select('id');
  if (!claimed || claimed.length !== 1) return json({ ok: false, error: 'job already started' }, 409, cors);

  EdgeRuntime.waitUntil(work(admin, jobId, job.path, prompt));
  return json({ ok: true }, 202, cors);
});
