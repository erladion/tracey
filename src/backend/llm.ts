// A language model behind an OpenAI-style API (llama.cpp's llama-server, vLLM, Ollama,
// LM Studio, or a hosted one over https with an API key): the models it has, its context
// window, and chat completions. Only what suggesting test cases needs. The context-size
// and thinking handling follow Smith's (github.com/erladion/Smith) server.ts and reasoning.ts.
import type { ChatMessage, LlmSettings, LlmStatus } from '../shared/api';
import { reachError } from './jira';

export interface LlmSetup {
  url: string; // the API's base, as http://localhost:8080/v1
  model: string; // '' : the server's first
  key: string | null; // sent as a Bearer token
  think: boolean;
  candidates: number; // 0: from the context size
}

// Where the setup comes from: the desktop app keeps each user's (the key encrypted), the
// web server takes its environment (TRACE_LLM_URL, TRACE_LLM_MODEL, TRACE_LLM_KEY…).
export interface LlmStore {
  editable: boolean;
  desktop: boolean; // for the wording of network errors
  get(): Promise<LlmSetup | null>;
  set(setup: Omit<LlmSetup, 'key'> & { key: string | null | undefined }): Promise<void>; // key undefined: keep it
  fetch?: typeof fetch; // the desktop app's goes through Chromium (system certificates, proxy)
}

// The API's base: without a trailing slash, or the endpoint pasted by mistake.
export const normalizeLlmUrl = (url: string) =>
  url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|models)$/, '');

export function envLlm(): LlmSetup | null {
  const url = process.env.TRACE_LLM_URL?.trim();
  if (!url) return null;
  return {
    url: normalizeLlmUrl(url),
    model: process.env.TRACE_LLM_MODEL?.trim() ?? '',
    key: process.env.TRACE_LLM_KEY?.trim() || null,
    think: /^(1|true|yes|on)$/i.test(process.env.TRACE_LLM_THINK ?? ''),
    candidates: Number(process.env.TRACE_LLM_CANDIDATES) || 0,
  };
}

class LlmError extends Error {}

type Answer = { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };

export function createLlm(store: LlmStore) {
  const contextSizes = new Map<string, number | null>(); // url + model → its window

  async function request<T>(setup: LlmSetup, path: string, body?: unknown, timeout = 30_000): Promise<T> {
    if (!/^https?:\/\/[^\s/]+/.test(setup.url)) throw new LlmError('Set the language model’s address under Settings (http://localhost:8080/v1, or https://…).');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (setup.key) headers.Authorization = `Bearer ${setup.key}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await (store.fetch ?? fetch)(`${setup.url}${path}`, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch (e) {
      throw new LlmError(
        reachError(e, setup.url, store.desktop, { what: 'the language model', where: 'its address under Settings, and that the server is running', waited: waitText(timeout) }),
      );
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403)
      throw new LlmError(`The language model’s server refused the request (${res.status}): ${setup.key ? 'check the API key' : 'it needs an API key'}.${detailOf(text)}`);
    if (res.status === 404)
      throw new LlmError(`Nothing at ${setup.url}${path} (404): check the address. OpenAI-style servers usually end in /v1, as http://localhost:8080/v1.${detailOf(text)}`);
    if (!res.ok) throw new LlmError(`The language model’s server answered ${res.status}.${detailOf(text)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new LlmError(`The language model’s server answered with something that isn’t JSON: is ${setup.url} an OpenAI-style API?`);
    }
  }

  type Listed = { id: string; contextSize?: number };
  async function models(setup: LlmSetup): Promise<Listed[]> {
    return listedModels(await request<unknown>(setup, '/models'));
  }

  // The model's context window: from the model list (vLLM's max_model_len), else from
  // llama.cpp's /props (n_ctx per slot). null when the server doesn't say.
  async function contextSize(setup: LlmSetup, model: string, listed: Listed[]): Promise<number | null> {
    const key = `${setup.url}\n${model}`;
    if (contextSizes.has(key)) return contextSizes.get(key)!;
    let n: number | null = listed.find((m) => m.id === model)?.contextSize ?? null;
    if (!n) {
      try {
        const root = { ...setup, url: setup.url.replace(/\/v1$/, '') };
        const p = await request<{ n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } }>(root, `/props?model=${encodeURIComponent(model)}`, undefined, 5_000);
        const v = p.default_generation_settings?.n_ctx ?? p.n_ctx;
        n = typeof v === 'number' && v > 0 ? v : null;
      } catch {
        n = null;
      }
    }
    contextSizes.set(key, n);
    return n;
  }

  const setupOrThrow = async () => {
    const s = await store.get();
    if (!s?.url) throw new LlmError(store.editable ? 'No language model set up yet: add its address under Settings.' : 'The server has no language model: set TRACE_LLM_URL where it runs.');
    return s;
  };

  return {
    async status(): Promise<LlmStatus> {
      const s = await store.get().catch(() => null);
      const base = { editable: store.editable, url: s?.url ?? '', model: s?.model ?? '', hasKey: !!s?.key, think: !!s?.think, candidates: s?.candidates ?? 0 };
      if (!s?.url) return { ...base, models: [], contextSize: null, error: null };
      try {
        const listed = await models(s);
        const model = s.model || listed[0]?.id || '';
        return { ...base, models: listed.map((m) => m.id), contextSize: model ? await contextSize(s, model, listed) : null, error: null };
      } catch (e) {
        return { ...base, models: [], contextSize: null, error: (e as Error).message };
      }
    },

    async setup(settings: LlmSettings) {
      if (!store.editable) throw new LlmError('The language model is set where the server runs (TRACE_LLM_URL).');
      const url = normalizeLlmUrl(String(settings.url ?? ''));
      if (url && !/^https?:\/\/[^\s/]+/.test(url)) throw new LlmError('The address must start with http:// or https://.');
      contextSizes.clear();
      await store.set({
        url,
        model: String(settings.model ?? '').trim(),
        key: settings.key === undefined ? undefined : settings.key ? String(settings.key).trim() : null,
        think: !!settings.think,
        candidates: Math.max(0, Math.min(500, Math.round(Number(settings.candidates) || 0))),
      });
    },

    async chat(messages: ChatMessage[], json: boolean): Promise<string> {
      if (!Array.isArray(messages) || messages.length > 20 || JSON.stringify(messages).length > 2_000_000) throw new LlmError('That question is too long to send.');
      const s = await setupOrThrow();
      const model = s.model || (await models(s))[0]?.id;
      if (!model) throw new LlmError('The language model’s server lists no models: choose one under Settings.');
      // Thinking (Qwen3-style templates read enable_thinking): off unless asked for, as it
      // mostly costs time here. A thinking model needs room for its thoughts.
      const base = { model, messages, temperature: 0, stream: false, max_tokens: s.think ? 16_000 : 2_000 };
      const thinking = s.think ? {} : { chat_template_kwargs: { enable_thinking: false } };
      const tries = [
        ...(json ? [{ ...base, ...thinking, response_format: { type: 'json_object' } }] : []),
        { ...base, ...thinking },
        base,
      ];
      const wait = s.think ? 600_000 : 180_000;
      let last: unknown = null;
      for (const body of tries) {
        try {
          const a = await request<Answer>(s, '/chat/completions', body, wait);
          const choice = a.choices?.[0];
          const text = choice?.message?.content ?? '';
          if (!text.trim() && choice?.finish_reason === 'length') throw new LlmError('The model ran out of room before answering: allow it fewer test cases per issue, or turn thinking off.');
          return text;
        } catch (e) {
          last = e;
          // A server that doesn't know a field (JSON mode, the thinking switch) answers 400
          // or 422: ask again without it. Anything else is an answer in itself.
          if (!/answered (400|422)/.test((e as Error).message)) throw e;
        }
      }
      throw last;
    },
  };
}

const waitText = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

// The models in a /models answer, however the server shapes it: OpenAI's {data: [{id}]}
// (vLLM adds max_model_len), llama.cpp's and Ollama's {models: [{name, model}]}, a bare
// list, or names as an object's keys. Duplicates once; what can't be read, left out.
export function listedModels(r: unknown): { id: string; contextSize?: number }[] {
  const out: { id: string; contextSize?: number }[] = [];
  const add = (m: unknown) => {
    if (typeof m === 'string') return out.push({ id: m });
    if (!m || typeof m !== 'object') return;
    const x = m as Record<string, unknown>;
    const id = [x.id, x.model, x.name].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    if (!id) return;
    // The window it runs with (not the one it was trained with, which may be larger).
    const ctx = [x.max_model_len, x.context_length, x.max_context_length, x.context_window].find((v) => typeof v === 'number' && v > 0) as number | undefined;
    out.push({ id, contextSize: ctx });
  };
  const list = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') for (const [k, info] of Object.entries(v)) if (info && typeof info === 'object' && !Array.isArray(info)) add({ id: k, ...info });
  };
  if (Array.isArray(r)) list(r);
  else if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    list(o.data);
    list(o.models);
  }
  const seen = new Set<string>();
  return out.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

// What the server said went wrong, if it said (OpenAI style: {"error": {"message": …}}).
function detailOf(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: unknown };
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message ?? (typeof j.detail === 'string' ? j.detail : null));
    return m ? ` It said: “${String(m).slice(0, 300)}”` : '';
  } catch {
    return text.trim() && !/<html/i.test(text) ? ` It said: “${text.trim().slice(0, 200)}”` : '';
  }
}
