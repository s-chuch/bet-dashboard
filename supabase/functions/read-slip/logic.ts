// Pure logic for read-slip: no Deno or network imports, only erasable TypeScript syntax,
// so Node (>= 22.18) can import it directly in tests/test_read_slip_logic.js.

export const MAX_ROWS = 30;
export const DEFAULT_MODELS = 'gemini-2.5-flash,gemini-2.5-pro';

export function parseModels(env?: string | null): string[] {
  const list = String(env ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_MODELS.split(',');
}

// Strip ```json fences and parse. Throws on invalid JSON.
export function parseJsonText(text: string): unknown {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

// Gemini generateContent reply -> the text of the first candidate ('' when missing/blocked).
export function geminiText(resp: any): string {
  const parts = resp?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
}

// Parsed JSON -> array of bet objects (max MAX_ROWS), or null if the shape is unusable.
export function normalizeBets(parsed: any, max: number = MAX_ROWS): Record<string, unknown>[] | null {
  let arr: unknown = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.bets)) arr = parsed.bets;
    else if (Array.isArray(parsed.rows)) arr = parsed.rows;
  }
  if (!Array.isArray(arr)) return null;
  const rows = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  return rows.slice(0, max) as Record<string, unknown>[];
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Try each model in order. callModel(model) must return the raw reply text or throw (HTTP error, timeout).
// A model "fails" when it throws or its reply is not parseable into a bet array; then the next one is tried.
// An empty array is a valid answer (no bets found) and is returned without trying further models.
export async function readWithFallback(
  models: string[],
  callModel: (model: string) => Promise<string>,
  max: number = MAX_ROWS,
): Promise<{ ok: true; rows: Record<string, unknown>[]; model: string } | { ok: false; error: string }> {
  let last = '';
  for (const model of models) {
    try {
      const text = await callModel(model);
      const rows = normalizeBets(parseJsonText(text), max);
      if (rows) return { ok: true, rows, model };
      last = 'unexpected reply format';
    } catch (e: any) {
      last = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e).slice(0, 120);
    }
  }
  return { ok: false, error: 'Could not read the screenshot (' + (last || 'no model available') + '). Try again or add the bets manually.' };
}
