import { createHash, randomBytes } from 'node:crypto';
import {
  type ChatRequest,
  type ZeusChatMessage,
  resolveBrowserGatewayConfig,
  streamCustom,
} from './catalog.js';
import { streamGeminiWeb, streamQwenApp } from './webscrapers.js';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export function fakeIpv4(): string {
  const b = randomBytes(4);
  const first = (b[0]! % 200) + 11;
  return `${first}.${b[1]!}.${b[2]!}.${(b[3]! % 250) + 1}`;
}

export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * DeepAI FIPS 180-4 triple-SHA256 / MD5 tryit-{random}-{hash} key generator.
 */
export function generateDeepAiTryitKey(userAgent: string = CHROME_UA): string {
  const r = String(Math.floor(Math.random() * 100_000_000_000));
  const secret = 'hackers_become_a_little_stinkier_every_time_they_hack';
  const h1 = createHash('sha256')
    .update(`${userAgent}${createHash('sha256').update(`${userAgent}${createHash('sha256').update(`${userAgent}${r}${secret}`).digest('hex')}`).digest('hex')}`)
    .digest('hex');
  return `tryit-${r}-${h1}`;
}

export function cleanChatJimmyOutput(raw: string): { text: string; think: string } {
  let s = raw;
  let think = '';
  while (true) {
    const start = s.indexOf('<|stats|>');
    if (start === -1) break;
    const end = s.indexOf('<|/stats|>', start);
    if (end !== -1) {
      s = s.slice(0, start) + s.slice(end + 10);
    } else {
      s = s.slice(0, start);
      break;
    }
  }
  while (true) {
    const start = s.indexOf('<|think|>');
    if (start === -1) break;
    const end = s.indexOf('<|/think|>', start);
    if (end !== -1) {
      think += s.slice(start + 9, end);
      s = s.slice(0, start) + s.slice(end + 10);
    } else {
      break;
    }
  }
  return { text: s.trim(), think: think.trim() };
}

export function normalizeMultiTurnMessages(
  messages: ZeusChatMessage[],
  maxHistoryTurns = 14,
  maxOlderTurnChars = 6000,
  maxLastUserChars = 48000,
): ZeusChatMessage[] {
  if (!messages.length) {
    return [{ role: 'user', content: 'Hello' }];
  }
  const len = messages.length;
  const lastIdx = len - 1;
  const keepFrom = len > maxHistoryTurns + 1 ? len - maxHistoryTurns : 0;
  const normalized: ZeusChatMessage[] = [];

  for (let idx = 0; idx < len; idx++) {
    if (idx > 0 && idx < keepFrom) continue;
    const m = messages[idx]!;
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const rawContent = (m.content ?? '').trim();
    if (!rawContent && !(m.attachments && m.attachments.length > 0)) continue;

    let content = rawContent;
    if (idx === lastIdx) {
      if (content.length > maxLastUserChars) {
        const headLen = Math.floor(maxLastUserChars * 0.4);
        const tailLen = maxLastUserChars - headLen;
        content = `${content.slice(0, headLen)}\n\n${content.slice(content.length - tailLen)}\n`;
      }
    } else if (content.length > maxOlderTurnChars) {
      const headLen = Math.floor(maxOlderTurnChars * 0.6);
      const tailLen = maxOlderTurnChars - headLen;
      content = `${content.slice(0, headLen)}\n...[compacted earlier turn]...\n${content.slice(content.length - tailLen)}`;
    }

    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n\n${content}`;
      if (m.attachments?.length) {
        prev.attachments = [...(prev.attachments ?? []), ...m.attachments];
      }
      continue;
    }
    if (normalized.length === 0 && role === 'assistant') {
      normalized.push({ role: 'user', content: 'Continue the session.' });
    }
    normalized.push({
      role,
      content,
      ...(m.attachments?.length ? { attachments: [...m.attachments] } : {}),
    });
  }

  if (normalized.length === 0) {
    normalized.push({ role: 'user', content: 'Hello' });
  }
  return normalized;
}

let cachedInceptionToken: { token: string; exp: number } | null = null;

async function ensureInceptionToken(forceRefresh: boolean, signal: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && cachedInceptionToken && cachedInceptionToken.exp > now + 60) {
    return cachedInceptionToken.token;
  }
  const ip = fakeIpv4();
  const res = await fetch('https://chat.inceptionlabs.ai/api/session', {
    method: 'GET',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://chat.inceptionlabs.ai',
      Referer: 'https://chat.inceptionlabs.ai/',
      'X-Forwarded-For': ip,
      'X-Real-IP': ip,
    },
  });
  if (!res.ok) {
    throw new Error(`Inception session HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token?: string };
  const token = (data.token ?? '').trim();
  if (!token) {
    throw new Error('Inception session returned empty token');
  }
  cachedInceptionToken = { token, exp: now + 3600 };
  return token;
}

async function streamMercury3(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages);
  const effort = req.effort === 'low' ? 'low' : req.effort === 'medium' ? 'medium' : 'high';

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureInceptionToken(attempt > 0, signal);
    const incMsgs: Array<Record<string, unknown>> = [];
    if (req.system.trim()) {
      incMsgs.push({
        id: randomHex(8),
        role: 'user',
        parts: [{ type: 'text', text: `[System Specification]\n${req.system.slice(0, 28000)}` }],
      });
      incMsgs.push({
        id: randomHex(8),
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: 'Understood. I will follow the system specification and tool-calling protocol strictly.',
          },
        ],
      });
    }
    for (const m of normalized) {
      incMsgs.push({
        id: randomHex(8),
        role: m.role,
        parts: [{ type: 'text', text: m.content }],
      });
    }

    const ip = fakeIpv4();
    const res = await fetch('https://chat.inceptionlabs.ai/api/chat', {
      method: 'POST',
      signal,
      headers: {
        'User-Agent': CHROME_UA,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, */*',
        Authorization: `Bearer ${token}`,
        Origin: 'https://chat.inceptionlabs.ai',
        Referer: 'https://chat.inceptionlabs.ai/',
        'X-Forwarded-For': ip,
        'X-Real-IP': ip,
      },
      body: JSON.stringify({
        id: randomHex(8),
        model: 'mercury-3',
        messages: incMsgs,
        reasoning_effort: effort,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      cachedInceptionToken = null;
      if (attempt === 0) continue;
    }
    if (!res.ok || !res.body) {
      throw new Error(`Mercury 3 HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let emitted = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('data:')) {
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta =
              j.choices?.[0]?.delta?.content ??
              j.delta?.text ??
              j.delta ??
              (j.type === 'text-delta' ? j.textDelta : '') ??
              '';
            const reason =
              j.choices?.[0]?.delta?.reasoning_content ??
              (j.type === 'reasoning' || j.type === 'reasoning-delta' ? j.textDelta ?? j.delta : '') ??
              '';
            if (typeof reason === 'string' && reason) {
              onReasoning(reason);
            }
            if (typeof delta === 'string' && delta) {
              emitted = true;
              onDelta(delta);
            }
          } catch {
            // Vercel AI SDK stream format: 0:"..." or g:"..."
          }
        } else if (t.startsWith('0:')) {
          try {
            const txt = JSON.parse(t.slice(2));
            if (typeof txt === 'string' && txt) {
              emitted = true;
              onDelta(txt);
            }
          } catch {}
        } else if (t.startsWith('g:')) {
          try {
            const r = JSON.parse(t.slice(2));
            if (typeof r === 'string' && r) {
              onReasoning(r);
            }
          } catch {}
        }
      }
    }
    if (emitted) return;
  }
  throw new Error('Mercury 3 stream produced no output');
}

async function streamChatJimmy(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 10, 4000, 24000);
  const msgs: Array<{ role: string; content: string }> = [];
  if (req.system.trim()) {
    msgs.push({ role: 'system', content: req.system.slice(0, 16000) });
  }
  for (const m of normalized) {
    msgs.push({ role: m.role, content: m.content });
  }
  const ip = fakeIpv4();
  const res = await fetch('https://chatjimmy.ai/api/chat', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      'Content-Type': 'application/json',
      Accept: '*/*',
      Origin: 'https://chatjimmy.ai',
      Referer: 'https://chatjimmy.ai/',
      'X-Real-IP': ip,
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify({
      messages: msgs,
      chatOptions: {
        selectedModel: 'llama3.1-8B',
        topK: 8,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`ChatJimmy HTTP ${res.status}`);
  }
  const raw = await res.text();
  const { text, think } = cleanChatJimmyOutput(raw);
  if (think) onReasoning(think);
  if (!text) throw new Error('ChatJimmy returned empty response');
  onDelta(text);
}

async function streamK2Horizon(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 12, 5000, 32000);
  const msgs: Array<{ role: string; content: string }> = [];
  if (req.system.trim()) {
    msgs.push({ role: 'system', content: req.system.slice(0, 20000) });
  }
  for (const m of normalized) {
    msgs.push({ role: m.role, content: m.content });
  }
  const ip = fakeIpv4();
  const res = await fetch('https://www.k2think.ai/api/guest/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: 'https://www.k2think.ai',
      Referer: 'https://www.k2think.ai/guest',
      'X-Forwarded-For': ip,
      'X-Real-IP': ip,
    },
    body: JSON.stringify({
      model: 'IFM/K2-Horizon-375B-A23B',
      messages: msgs,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`K2Horizon HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let fullContent = '';
  let emittedTextLen = 0;
  let emittedThinkLen = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content ?? '';
        if (typeof delta === 'string' && delta) {
          fullContent += delta;
          const closeIdx = fullContent.indexOf('</details>');
          if (fullContent.startsWith('<details') && closeIdx === -1) {
            const gt = fullContent.indexOf('>');
            if (gt !== -1) {
              const thinkBody = fullContent.slice(gt + 1).replace(/^<summary>.*?<\/summary>/s, '');
              if (thinkBody.length > emittedThinkLen) {
                onReasoning(thinkBody.slice(emittedThinkLen));
                emittedThinkLen = thinkBody.length;
              }
            }
          } else if (closeIdx !== -1) {
            const after = fullContent.slice(closeIdx + 10);
            if (after.length > emittedTextLen) {
              onDelta(after.slice(emittedTextLen));
              emittedTextLen = after.length;
            }
          } else {
            if (fullContent.length > emittedTextLen) {
              onDelta(fullContent.slice(emittedTextLen));
              emittedTextLen = fullContent.length;
            }
          }
        }
      } catch {}
    }
  }
}

async function streamDeepAi(
  req: ChatRequest,
  onDelta: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 10, 4000, 24000);
  const history: Array<{ role: string; content: string }> = [];
  if (req.system.trim()) {
    history.push({ role: 'user', content: `[System Instructions]\n${req.system.slice(0, 16000)}` });
    history.push({ role: 'assistant', content: 'Understood.' });
  }
  for (const m of normalized) {
    history.push({ role: m.role, content: m.content });
  }
  const form = new FormData();
  form.append('chat_style', 'chat');
  form.append('chatHistory', JSON.stringify(history));
  form.append('model', req.model || 'standard');

  const res = await fetch('https://api.deepai.org/hacking_is_a_serious_crime', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      'api-key': generateDeepAiTryitKey(CHROME_UA),
      Origin: 'https://deepai.org',
      Referer: 'https://deepai.org/chat',
    },
    body: form,
  });
  if (!res.ok || !res.body) {
    throw new Error(`DeepAI HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const txt = dec.decode(value, { stream: true });
    if (txt) onDelta(txt);
  }
}

async function streamYqCloud(
  req: ChatRequest,
  onDelta: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 8, 3500, 20000);
  const prompt = normalized.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
  const res = await fetch('https://api.binjie.fun/api/generateStream', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      'Content-Type': 'application/json',
      Origin: 'https://chat18.aichatos58.com',
      Referer: 'https://chat18.aichatos58.com/',
    },
    body: JSON.stringify({
      prompt,
      userId: `#/chat/${Date.now()}`,
      network: true,
      system: req.system.slice(0, 12000),
      withoutContext: false,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`YQCloud HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const txt = dec.decode(value, { stream: true });
    if (txt) onDelta(txt);
  }
}

/**
 * Unified Zeus Provider Streaming Entry Point.
 * Routes any of the 41 Zeus providers (and custom endpoints) with automatic
 * resilient fallback chain so OpenDesign runs never fail due to upstream rate limits.
 */
export async function streamZeusProvider(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (req.custom?.baseUrl) {
    await streamCustom(req, onDelta, onReasoning, signal);
    return;
  }

  let emittedAny = false;
  const wrappedDelta = (t: string) => {
    if (t) {
      emittedAny = true;
      onDelta(t);
    }
  };

let cachedMotifConversationId: string | null = null;

async function streamMotif(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 10, 5000, 24000);
  const motifModel = req.model.includes('12.7') || req.model.includes('12-7')
    ? 'motif-12-7b-reasoning'
    : 'motif-102b';
  const eff = req.effort === 'low' ? 'small' : req.effort === 'medium' ? 'medium' : 'high';
  const sections: string[] = [];
  if (req.system.trim()) {
    sections.push(`[System Instructions]\n${req.system.slice(0, 20000)}`);
  }
  if (normalized.length > 1) {
    const hist = normalized
      .slice(0, -1)
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.slice(0, 8000)}`)
      .join('\n\n');
    sections.push(`[Conversation History]\n${hist}`);
  }
  const lastUser = normalized[normalized.length - 1]?.content ?? '';
  sections.push(`[Current User Request]\n${lastUser}`);

  const res = await fetch('https://chat.motiftech.io/api/v1/enterprise/chat', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Origin: 'https://chat.motiftech.io',
      Referer: 'https://chat.motiftech.io/chat',
    },
    body: JSON.stringify({
      query: sections.join('\n\n'),
      conversation_id: cachedMotifConversationId,
      project_id: null,
      template_id: null,
      forced_skill_names: [],
      disabled_skill_names: [],
      language: 'en',
      timezone: 'UTC',
      mode: 'chat',
      reasoning_effort: eff,
      model: motifModel,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Motif HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      try {
        const ev = JSON.parse(raw);
        const etype = ev.type ?? '';
        if (etype === 'chat.reasoning' || etype === 'chat.thinking' || etype === 'chat.thought') {
          if (typeof ev.data === 'string' && ev.data) onReasoning(ev.data);
        } else if (etype === 'chat.text') {
          if (typeof ev.data === 'string' && ev.data) onDelta(ev.data);
        } else if (etype === 'shared.data.conversation_id') {
          if (typeof ev.data === 'string' && ev.data) cachedMotifConversationId = ev.data;
        } else if (etype === 'shared.sign') {
          return;
        }
      } catch {}
    }
  }
}

async function streamLongCat(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 10, 5000, 24000);
  const lastUser = normalized[normalized.length - 1]?.content ?? '';
  const maxSys = Math.max(6000, 26000 - lastUser.length);
  const sysPrefix = req.system.slice(0, maxSys);
  const content = sysPrefix.trim() ? `${sysPrefix}\n\n${lastUser}` : lastUser.slice(0, 26000);

  const lcMsgs: Array<Record<string, unknown>> = [];
  for (const m of normalized.slice(0, -1)) {
    lcMsgs.push({
      role: m.role,
      events: [
        {
          type: m.role === 'assistant' ? 'content' : 'userMsg',
          content: m.content.slice(0, 16000),
          status: 'FINISHED',
        },
      ],
      chatStatus: 'FINISHED',
      messageId: 10_000_000 + Math.floor(Math.random() * 89_000_000),
      idType: 'custom',
    });
  }
  lcMsgs.push({
    role: 'user',
    events: [{ type: 'userMsg', content, status: 'FINISHED' }],
    chatStatus: 'FINISHED',
    messageId: 10_000_000 + Math.floor(Math.random() * 89_000_000),
    idType: 'custom',
  });
  lcMsgs.push({
    role: 'assistant',
    events: [],
    chatStatus: 'LOADING',
    messageId: 10_000_000 + Math.floor(Math.random() * 89_000_000),
    idType: 'custom',
  });

  const res = await fetch('https://longcat.chat/api/v1/chat-completion-oversea-V2', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'text/event-stream,application/json',
      'Content-Type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'X-Client-Language': 'en',
      'm-appkey': 'fe_com.sankuai.friday.fe.longcat',
      Origin: 'https://longcat.chat',
      Referer: 'https://longcat.chat/t',
    },
    body: JSON.stringify({
      content,
      agentId: '1',
      messages: lcMsgs,
      reasonEnabled: 1,
      searchEnabled: 0,
      regenerate: 0,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`LongCat HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      try {
        const ev = JSON.parse(raw);
        const eventObj = ev.event;
        if (eventObj) {
          const etype = eventObj.type ?? '';
          if ((etype === 'reason' || etype === 'think' || etype === 'thinking') && typeof eventObj.content === 'string') {
            onReasoning(eventObj.content);
          } else if (etype === 'content' && typeof eventObj.content === 'string') {
            onDelta(eventObj.content);
          } else if (etype === 'finish') {
            return;
          }
        }
      } catch {}
    }
  }
}

async function streamPtero(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const normalized = normalizeMultiTurnMessages(req.messages, 10, 5000, 24000);
  const history = normalized.slice(0, -1).map((m) => ({
    role: m.role,
    text: m.content.slice(0, 12000),
    attachments: [],
  }));
  const lastUser = normalized[normalized.length - 1]?.content ?? '';
  const messageText = req.system.trim()
    ? `[System instructions: ${req.system.slice(0, 18000)}]\n\n${lastUser}`
    : lastUser;

  const res = await fetch('https://ptero.pro/wp-json/mlp/v1/chat-stream', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': CHROME_UA,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      Origin: 'https://ptero.pro',
      Referer: 'https://ptero.pro/',
      'X-MLP-Guest-Token': randomHex(16),
      'X-MLP-Guest-Username': 'nebian',
    },
    body: JSON.stringify({
      message: messageText,
      model: req.model || 'agnes-2.5-flash:agnes',
      conversation_id: randomHex(16),
      history,
      attachments: [],
      github_repo: '',
      lang: 'en',
      mode: 'quick',
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Ptero HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      try {
        const ev = JSON.parse(raw);
        if (typeof ev.thinking_token === 'string' && ev.thinking_token) {
          onReasoning(ev.thinking_token);
        }
        if (typeof ev.token === 'string' && ev.token) {
          onDelta(ev.token);
        }
        if (ev.done === true) return;
      } catch {}
    }
  }
}

async function streamUnikey(
  req: ChatRequest,
  onDelta: (t: string) => void,
  onReasoning: (t: string) => void,
  signal: AbortSignal,
): Promise<void> {
  await streamCustom(
    {
      ...req,
      custom: {
        baseUrl: 'https://www.getunikey.ai/api/anonymous',
        apiKey: '',
        format: 'openai',
      },
    },
    onDelta,
    onReasoning,
    signal,
  );
}

  const tryPrimary = async (): Promise<void> => {
    switch (req.provider) {
      case 'mercury3':
        await streamMercury3(req, wrappedDelta, onReasoning, signal);
        return;
      case 'chatjimmy':
        await streamChatJimmy(req, wrappedDelta, onReasoning, signal);
        return;
      case 'k2horizon':
        await streamK2Horizon(req, wrappedDelta, onReasoning, signal);
        return;
      case 'motif':
        await streamMotif(req, wrappedDelta, onReasoning, signal);
        return;
      case 'longcat':
        await streamLongCat(req, wrappedDelta, onReasoning, signal);
        return;
      case 'ptero':
        await streamPtero(req, wrappedDelta, onReasoning, signal);
        return;
      case 'unikey':
        await streamUnikey(req, wrappedDelta, onReasoning, signal);
        return;
      case 'deepai':
        await streamDeepAi(req, wrappedDelta, signal);
        return;
      case 'yqcloud':
        await streamYqCloud(req, wrappedDelta, signal);
        return;
      case 'qwen':
        await streamQwenApp(req, wrappedDelta, signal);
        return;
      case 'geminiweb':
        await streamGeminiWeb(req, wrappedDelta, signal);
        return;
      default: {
        const gw = resolveBrowserGatewayConfig(req.provider, req.model);
        await streamCustom(
          {
            ...req,
            model: gw.model,
            custom: {
              baseUrl: gw.baseUrl,
              apiKey: gw.apiKey,
              format: gw.format,
            },
          },
          wrappedDelta,
          onReasoning,
          signal,
        );
      }
    }
  };

  try {
    await tryPrimary();
    if (emittedAny) return;
  } catch (err) {
    if (signal.aborted) throw err;
    if (emittedAny) return;
  }

  // Automatic resilient fallback chain across top keyless providers
  const fallbacks: Array<{ provider: string; model: string }> = [
    { provider: 'mercury3', model: 'mercury-3' },
    { provider: 'kilo', model: 'kilo-auto/free' },
    { provider: 'pollinations', model: 'openai' },
    { provider: 'chatjimmy', model: 'llama3.1-8b' },
  ].filter((f) => f.provider !== req.provider);

  let lastError: unknown = null;
  for (const fb of fallbacks) {
    if (signal.aborted) break;
    try {
      const fbReq: ChatRequest = { ...req, provider: fb.provider, model: fb.model };
      if (fb.provider === 'mercury3') {
        await streamMercury3(fbReq, wrappedDelta, onReasoning, signal);
      } else if (fb.provider === 'chatjimmy') {
        await streamChatJimmy(fbReq, wrappedDelta, onReasoning, signal);
      } else {
        const gw = resolveBrowserGatewayConfig(fb.provider, fb.model);
        await streamCustom(
          {
            ...fbReq,
            model: gw.model,
            custom: {
              baseUrl: gw.baseUrl,
              apiKey: gw.apiKey,
              format: gw.format,
            },
          },
          wrappedDelta,
          onReasoning,
          signal,
        );
      }
      if (emittedAny) return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All Zeus keyless providers failed to respond');
}
