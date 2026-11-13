import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildIndex, type SourceFile } from '../src/core/model';
import { candidateCount, issueText, readSuggestions, stripThinking, suggestPrompt, testIndex, words } from '../src/core/suggest';
import { createLlm, normalizeLlmUrl, type LlmSetup } from '../src/backend/llm';
import type { JiraIssue } from '../src/shared/api';

const file = (path: string, front: string, body = ''): SourceFile => ({ path, text: `---\n${front}\n---\n${body}\n` });
const files: SourceFile[] = [
  file('requirements/REQ-1.md', 'id: REQ-1\ntitle: Refunds of split payments'),
  file('requirements/REQ-2.md', 'id: REQ-2\ntitle: Invoice tax per region'),
  file('requirements/REQ-3.md', 'id: REQ-3\ntitle: Login with single sign-on'),
  file('tests/TC-1.md', 'id: TC-1\ntitle: Refund a payment split over two cards\nverifies: [REQ-1]\ncomponents: [payments]', '## Steps\n\n1. Pay with two cards\n2. Refund the order'),
  file('tests/TC-2.md', 'id: TC-2\ntitle: Tax line on an invoice for Sweden\nverifies: [REQ-2]'),
  file('tests/TC-3.md', 'id: TC-3\ntitle: Sign in through the company portal\nverifies: [REQ-3]'),
  file('tests/TC-4.md', 'id: TC-4\ntitle: Old refund flow\nstatus: obsolete\nverifies: [REQ-1]'),
];
const config = 'components:\n  payments: { name: Payments, paths: ["src/payments/**"] }\n';
const index = buildIndex(files, config);
const issue = (key: string, summary: string, description = ''): JiraIssue => ({
  key,
  summary,
  status: 'Done',
  statusCategory: 'done',
  type: 'Bug',
  labels: [],
  fixVersions: ['2.4.0'],
  description,
  field: [],
  remoteLinks: null,
});

describe('finding candidate test cases by their words', () => {
  it('reads words without endings or filler', () => {
    expect(words('The refunds of split Payments are failing')).toEqual(['refund', 'split', 'payment', 'fail']);
  });

  it('ranks the test cases sharing the most telling words first, and leaves out obsolete ones', () => {
    const search = testIndex(index);
    const hits = search.search(issueText(issue('PAY-1', 'Refund fails when a payment is split', 'Customers paying with two cards can not get a refund.')), 10);
    expect(hits.map((h) => h.item.id)).toEqual(['TC-1']);
    expect(hits[0].about).toBe('verifies REQ-1 Refunds of split payments · components: Payments');
    // Through the requirement's title: "region" is only there.
    expect(search.search('tax region', 10).map((h) => h.item.id)).toEqual(['TC-2']);
    expect(search.search('nothing like it', 10)).toEqual([]);
  });

  it('offers more candidates the larger the model’s context', () => {
    expect(candidateCount(0, null)).toBe(30);
    expect(candidateCount(0, 8192)).toBe(21);
    expect(candidateCount(0, 262144)).toBe(150);
    expect(candidateCount(60, 262144)).toBe(60);
  });
});

describe('asking the model and reading its answer', () => {
  const offered = new Set(['TC-1', 'TC-2']);

  it('gives the issue and the candidates, asking for JSON', () => {
    const [system, user] = suggestPrompt(issue('PAY-1', 'Refund fails for split payments', 'Two cards.'), testIndex(index).search('refund split', 5));
    expect(system.content).toContain('Answer with JSON only');
    expect(user.content).toContain('Jira issue PAY-1 (Bug): Refund fails for split payments');
    expect(user.content).toContain('Description:\nTwo cards.');
    expect(user.content).toContain('- TC-1: Refund a payment split over two cards (verifies REQ-1 Refunds of split payments · components: Payments)');
  });

  it('reads JSON after thinking, in fences, or as a bare list; leaves out made-up IDs', () => {
    expect(readSuggestions('<think>Hmm, {"tests": []} maybe</think>\n```json\n{"tests": [{"id": "tc-1", "why": "Tests the split refund."}]}\n```', offered)).toEqual({
      suggestions: [{ id: 'TC-1', why: 'Tests the split refund.' }],
      dropped: 0,
      readable: true,
    });
    expect(readSuggestions('Thinking first.</think>{"tests":[{"id":"TC-9","why":"x"},{"id":"TC-2"},{"id":"TC-2"}]}', offered)).toEqual({
      suggestions: [{ id: 'TC-2', why: '' }],
      dropped: 1,
      readable: true,
    });
    expect(readSuggestions('["TC-1", "TC-2"]', offered).suggestions.map((s) => s.id)).toEqual(['TC-1', 'TC-2']);
    expect(readSuggestions('Sorry, none of these fit.', offered)).toEqual({ suggestions: [], dropped: 0, readable: false });
    expect(stripThinking('<think>a</think> b')).toBe('b');
  });
});

describe('the language model client', () => {
  // A stand-in server over https with a self-signed certificate, needing an API key:
  // vLLM-style /v1/models with the context size, and a chat endpoint that, like some
  // servers, refuses JSON mode (400) so the client asks again without it.
  let server: https.Server;
  let url = '';
  const seen: { path: string; auth: string | undefined; body: Record<string, unknown> | null }[] = [];
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracey-llm-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    // Trusted as a company's own authority would be (what network.ts does with the system store).
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);
    server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.headers.authorization !== 'Bearer sk-test') return send(401, { error: { message: 'Invalid API key' } });
        if (req.url === '/v1/models') return send(200, { data: [{ id: 'qwen-27b', max_model_len: 262144 }] });
        if (req.url === '/v1/chat/completions') {
          if (body?.response_format) return send(400, { error: { message: 'response_format is not supported' } });
          return send(200, { choices: [{ message: { content: '<think>Refund and split.</think>{"tests":[{"id":"TC-1","why":"Tests split refunds."}]}' } }] });
        }
        send(404, { error: 'not found' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://localhost:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server?.close());

  const store = (setup: Partial<LlmSetup>) => ({
    editable: true,
    desktop: false,
    get: async () => ({ url, model: '', key: 'sk-test', think: false, candidates: 0, ...setup }),
    set: async () => {},
  });

  it('lists the models and the context size, over https with the API key', async () => {
    const status = await createLlm(store({})).status();
    expect(status).toMatchObject({ url, models: ['qwen-27b'], contextSize: 262144, hasKey: true, error: null });
    expect(seen.at(-1)?.auth).toBe('Bearer sk-test');
  });

  it('asks without JSON mode when the server refuses it, with thinking off, and gets the answer', async () => {
    seen.length = 0;
    const answer = await createLlm(store({})).chat([{ role: 'user', content: 'Which tests?' }], true);
    expect(readSuggestions(answer, new Set(['TC-1'])).suggestions).toEqual([{ id: 'TC-1', why: 'Tests split refunds.' }]);
    const chats = seen.filter((s) => s.path === '/v1/chat/completions');
    expect(chats.map((c) => 'response_format' in c.body!)).toEqual([true, false]);
    expect(chats[1].body).toMatchObject({ model: 'qwen-27b', temperature: 0, chat_template_kwargs: { enable_thinking: false } });
  });

  it('says when the key is wrong, and when the address is', async () => {
    await expect(createLlm(store({ key: 'wrong' })).chat([{ role: 'user', content: 'x' }], false)).rejects.toThrow(
      'The language model’s server refused the request (401): check the API key. It said: “Invalid API key”',
    );
    expect((await createLlm(store({ url: url.replace('/v1', '/v2') })).status()).error).toContain('(404): check the address. OpenAI-style servers usually end in /v1');
    // A port nothing listens on.
    const free = await new Promise<number>((r) => {
      const probe = https.createServer().listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => r(port));
      });
    });
    expect((await createLlm(store({ url: `https://127.0.0.1:${free}/v1` })).status()).error).toMatch(/^Couldn't reach the language model at https:\/\/127\.0\.0\.1:\d+\/v1: .*ECONNREFUSED.*Nothing answers at that address/);
  });

  it('takes the API’s base however it’s pasted', () => {
    expect(normalizeLlmUrl(' http://localhost:8080/v1/ ')).toBe('http://localhost:8080/v1');
    expect(normalizeLlmUrl('https://llm.example.com/v1/chat/completions')).toBe('https://llm.example.com/v1');
  });
});
