import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest, ZeusChatMessage } from './catalog.js';

type Delta = (t: string) => void;

const QWEN_APP_BASE = 'https://chat.qwen.ai/api/v2';
const QWEN_MAIL_BASE = 'https://api.0mail.tech/v1';
const QWEN_APP_UA =
  'Dalvik/2.1.0 (Linux; U; Android 15; 25028RN03A Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.5.1) AppType/Release AplusBridgeLite,Dalvik/2.1.0 (Linux; U; Android 15; 25028RN03A Build/AP3A.240905.015.A2)';
const QWEN_APP_WAF = 'Z9Tr56YmQpXcO2K_d_3nAbJvRqMLFW8HTNjvRguWHEowM1xY';
const QWEN_MODELS = new Set([
  'qwen4-max',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.8-omni-flash',
  'qwen3.5-omni-plus',
  'qwen3.7-plus',
]);
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

interface QwenAccount {
  email: string;
  password: string;
  device: string;
  token: string;
  created: number;
  coolUntil: number;
}

let qwenPool: QwenAccount[] | null = null;
let qwenProvisionFailedUntil = 0;
let qwenProvisioning: Promise<QwenAccount> | null = null;

const nowSecs = () => Math.floor(Date.now() / 1000);

function poolFile(): string {
  const dir = path.join(process.env.OD_DATA_DIR || path.join(os.homedir(), '.opendesigns'));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return path.join(dir, 'qwen_pool.json');
}

function loadPool(): QwenAccount[] {
  if (qwenPool) return qwenPool;
  try {
    const raw = JSON.parse(readFileSync(poolFile(), 'utf8')) as Array<Record<string, unknown>>;
    qwenPool = raw.map((a) => ({
      email: String(a.email ?? ''),
      password: String(a.password ?? ''),
      device: String(a.device ?? ''),
      token: String(a.token ?? ''),
      created: Number(a.created ?? 0),
      coolUntil: Number(a.coolUntil ?? a.cool_until ?? 0),
    }));
  } catch {
    qwenPool = [];
  }
  return qwenPool;
}

function savePool(): void {
  try {
    writeFileSync(poolFile(), JSON.stringify(qwenPool ?? [], null, 2));
  } catch {
    /* best effort */
  }
}

function qwenHeaders(device: string, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': QWEN_APP_UA,
    Accept: 'application/json',
    'X-Platform': 'android',
    source: 'app',
    app_waf: QWEN_APP_WAF,
    'x-request-id': randomUUID(),
    'x-device-id': device,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function provisionQwenAccount(signal: AbortSignal): Promise<QwenAccount> {
  const session = randomUUID();
  const device = `ai${randomBytes(16).toString('hex')}`;
  const mail = { 'X-Session-Id': session };
  const domainsRes = await fetch(`${QWEN_MAIL_BASE}/domains`, { headers: mail, signal });
  const domains = (await domainsRes.json()) as Array<{ domain?: string; available?: boolean; premium?: boolean }>;
  const domain = domains.find(
    (d) => d.available && !d.premium && d.domain && d.domain !== 'cfdevelopment.online',
  )?.domain;
  if (!domain) throw new Error('No available 0mail domain');

  const inboxRes = await fetch(`${QWEN_MAIL_BASE}/inboxes`, {
    method: 'POST',
    headers: { ...mail, 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
    signal,
  });
  const inbox = (await inboxRes.json()) as { address?: string; id?: string };
  if (!inbox.address || !inbox.id) throw new Error('0mail inbox creation failed');

  const password = `Aa1!${randomBytes(7).toString('hex')}`;
  const pwHash = createHash('sha256').update(password).digest('hex');
  const signupRes = await fetch(`${QWEN_APP_BASE}/auths/signup`, {
    method: 'POST',
    headers: { ...qwenHeaders(device), 'Content-Type': 'application/json', 'Accept-Language': 'en-US' },
    body: JSON.stringify({ email: inbox.address, password: pwHash, name: `Od ${inbox.address.slice(0, 5)}` }),
    signal,
  });
  const signup = (await signupRes.json().catch(() => ({}))) as { success?: boolean };
  if (signup.success !== true) throw new Error('Qwen signup rejected');

  let link: string | null = null;
  for (let i = 0; i < 18 && !link; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    if (signal.aborted) throw new Error('aborted');
    try {
      const r = await fetch(`${QWEN_MAIL_BASE}/inboxes/${inbox.id}/messages`, { headers: mail, signal });
      const msgs = (await r.json()) as Array<{ body?: string }>;
      for (const m of msgs) {
        const body = m.body ?? '';
        const idx = body.indexOf('auths/activate');
        if (idx < 0) continue;
        const start = body.lastIndexOf('http', idx);
        if (start < 0) continue;
        const rest = body.slice(start);
        const end = rest.search(/["'<> \r\n]/);
        link = (end < 0 ? rest : rest.slice(0, end)).replace(/&amp;/g, '&');
        break;
      }
    } catch {
      /* keep polling */
    }
  }
  if (!link) throw new Error('Qwen activation email timeout');
  await fetch(link, { headers: qwenHeaders(device), redirect: 'manual', signal }).catch(() => undefined);

  const signinRes = await fetch(`${QWEN_APP_BASE}/auths/signin`, {
    method: 'POST',
    headers: { ...qwenHeaders(device), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: inbox.address, password: pwHash }),
    signal,
  });
  const signin = (await signinRes.json()) as { data?: { token?: string } };
  const token = signin.data?.token ?? '';
  if (!token) throw new Error('Qwen signin missing token');
  return { email: inbox.address, password, device, token, created: nowSecs(), coolUntil: 0 };
}

async function acquireQwenAccount(signal: AbortSignal): Promise<QwenAccount> {
  const pool = loadPool();
  const now = nowSecs();
  const ready = pool.find((a) => a.token && a.coolUntil <= now);
  if (ready) return ready;
  if (qwenProvisionFailedUntil > now) throw new Error('Qwen provisioning temporarily in cooldown');
  if (!qwenProvisioning) {
    qwenProvisioning = provisionQwenAccount(signal)
      .then((acct) => {
        pool.push(acct);
        if (pool.length > 8) pool.splice(0, pool.length - 8);
        savePool();
        return acct;
      })
      .catch((err) => {
        qwenProvisionFailedUntil = nowSecs() + 300;
        throw err;
      })
      .finally(() => {
        qwenProvisioning = null;
      });
  }
  return qwenProvisioning;
}

function coolQwenAccount(email: string, seconds: number): void {
  for (const a of loadPool()) if (a.email === email) a.coolUntil = nowSecs() + seconds;
  savePool();
}

function flattenPrompt(system: string, messages: ZeusChatMessage[], label: 'bracket' | 'plain'): string {
  let prompt = '';
  if (system.trim()) prompt += label === 'bracket' ? `[System]\n${system}\n\n` : `${system.slice(0, 16000)}\n\n`;
  if (messages.length > 1) {
    prompt += label === 'bracket' ? '[Conversation so far]\n' : 'Previous conversation:\n';
    for (const m of messages.slice(0, -1)) {
      const role = label === 'bracket' ? (m.role === 'assistant' ? 'Assistant' : 'User') : m.role;
      prompt += `${role}: ${m.content}\n`;
    }
    prompt += '\n';
  }
  const last = messages[messages.length - 1];
  if (last) prompt += label === 'bracket' ? `[User]\n${last.content}` : last.content;
  return prompt;
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}

export async function streamQwenApp(req: ChatRequest, onDelta: Delta, signal: AbortSignal): Promise<void> {
  const acct = await acquireQwenAccount(signal);
  const model = QWEN_MODELS.has(req.model) ? req.model : 'qwen4-max';
  const prompt = flattenPrompt(req.system, req.messages, 'bracket');
  const now = Date.now();
  const common = qwenHeaders(acct.device, acct.token);

  const newRes = await fetch(`${QWEN_APP_BASE}/chats/new`, {
    method: 'POST',
    headers: { ...common, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'New Chat',
      models: [model],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: now,
      project_id: '',
    }),
    signal,
  });
  const created = (await newRes.json().catch(() => ({}))) as { data?: { id?: string } };
  const chatId = created.data?.id;
  if (!chatId) {
    coolQwenAccount(acct.email, 600);
    throw new Error('Qwen chats/new missing id');
  }

  const res = await fetch(`${QWEN_APP_BASE}/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: { ...common, Accept: '*/*,text/event-stream', 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model,
      parent_id: null,
      version: '2.1',
      timestamp: now,
      share_id: '',
      origin_branch_message_id: '',
      messages: [
        {
          fid: randomUUID(),
          parentId: null,
          childrenIds: [],
          chat_type: 't2t',
          content: prompt,
          role: 'user',
          timestamp: now,
          sub_chat_type: 't2t',
          models: [model],
          user_action: 'chat',
          files: [],
          safety: { enabled: false },
          extra: { meta: { subChatType: 't2t' }, disable_recitation_policy: true, skip_safety_check: true },
          feature_config: {
            output_schema: 'phase',
            thinking_enabled: true,
            thinking_mode: 'Auto',
            auto_thinking: true,
            research_mode: 'normal',
            auto_search: false,
          },
        },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 403 || res.status === 401) coolQwenAccount(acct.email, 900);
    throw new Error(`Qwen HTTP ${res.status}`);
  }

  let inThink = false;
  let sawText = false;
  for await (const line of sseLines(res)) {
    if (!line.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim()) as {
        choices?: Array<{ delta?: { phase?: string; content?: string } }>;
      };
      const delta = ev.choices?.[0]?.delta;
      const content = delta?.content ?? '';
      const phase = delta?.phase ?? 'answer';
      if (!content) continue;
      if (phase === 'think' || phase === 'thinking') {
        if (!inThink) {
          inThink = true;
          onDelta('<think>');
        }
        onDelta(content);
      } else if (phase === 'answer') {
        if (inThink) {
          inThink = false;
          onDelta('</think>');
        }
        sawText = true;
        onDelta(content);
      }
    } catch {
      /* ignore non-JSON keepalives */
    }
  }
  if (inThink) onDelta('</think>');
  void fetch(`${QWEN_APP_BASE}/chats/${chatId}`, { method: 'DELETE', headers: common }).catch(() => undefined);
  if (!sawText) {
    coolQwenAccount(acct.email, 120);
    throw new Error('Qwen app stream ended without answer');
  }
}

function quoted(haystack: string, key: string): string | null {
  const pat = `"${key}":"`;
  const start = haystack.indexOf(pat);
  if (start < 0) return null;
  const rest = haystack.slice(start + pat.length);
  const end = rest.indexOf('"');
  return end < 0 ? null : rest.slice(0, end);
}

export async function streamGeminiWeb(req: ChatRequest, onDelta: Delta, signal: AbortSignal): Promise<void> {
  const warm = await fetch('https://gemini.google.com/app', {
    headers: { 'User-Agent': CHROME_UA, Accept: 'text/html' },
    signal,
  });
  if (!warm.ok) throw new Error(`Gemini Web warm HTTP ${warm.status}`);
  const cookies = (warm.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const html = await warm.text();
  const fsid = quoted(html, 'FdrFJe');
  if (!fsid) throw new Error('Gemini Web session token missing');
  const bl = quoted(html, 'cfb2h') ?? 'boq_gemini-web-uiserver_20261117.01_p0';
  const at = quoted(html, 'SNlM0e') ?? '';

  const prompt = flattenPrompt(req.system, req.messages, 'plain');
  const inner = [
    [prompt, 0, null, null, null, null, 0],
    ['en-US'],
    ['', '', '', null, null, null, null, null, null, ''],
    '',
    randomBytes(16).toString('hex'),
    null,
    [0],
    1,
    null,
    null,
    1,
    0,
  ];
  const freq = JSON.stringify([null, JSON.stringify(inner)]);
  const reqid = 100000 + Math.floor(Math.random() * 800000);
  let url =
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' +
    `?bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fsid)}&hl=en-US&_reqid=${reqid}&rt=c`;
  if (at) url += `&at=${encodeURIComponent(at)}`;

  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: 'https://gemini.google.com',
      Referer: 'https://gemini.google.com/',
      'x-same-domain': '1',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: `f.req=${encodeURIComponent(freq)}&`,
  });
  if (!res.ok) throw new Error(`Gemini Web HTTP ${res.status}`);

  let prev = '';
  let sawAny = false;
  for await (const line of sseLines(res)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    let entries: unknown;
    try {
      entries = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[2] !== 'string') continue;
      let payload: unknown;
      try {
        payload = JSON.parse(entry[2]);
      } catch {
        continue;
      }
      const parts = Array.isArray(payload) ? payload[4] : null;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!Array.isArray(part) || typeof part[0] !== 'string' || !part[0].startsWith('rc_')) continue;
        const snap = Array.isArray(part[1]) ? part[1][0] : null;
        if (typeof snap !== 'string') continue;
        const delta = snap.startsWith(prev) ? snap.slice(prev.length) : prev ? '' : snap;
        if (delta) {
          sawAny = true;
          onDelta(delta);
        }
        if (snap.length > prev.length) prev = snap;
      }
    }
  }
  if (!sawAny) throw new Error('Gemini Web stream returned no text');
}
