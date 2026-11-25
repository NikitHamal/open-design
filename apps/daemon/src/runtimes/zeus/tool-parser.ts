/**
 * Tolerant tool-call extraction and live stream splitting for keyless web-chat
 * providers, which have no native function calling. Everything a model might
 * plausibly emit is normalised into { name, arguments } so a tool call is never
 * silently dropped or reported as executed when it was not.
 */

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export const SUPPORTED_TOOLS = ['TodoWrite', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'] as const;

const ALIASES: Record<string, string> = {
  todowrite: 'TodoWrite',
  updateplan: 'TodoWrite',
  todo: 'TodoWrite',
  write: 'Write',
  writefile: 'Write',
  createfile: 'Write',
  writetofile: 'Write',
  savefile: 'Write',
  create: 'Write',
  read: 'Read',
  readfile: 'Read',
  viewfile: 'Read',
  view: 'Read',
  cat: 'Read',
  edit: 'Edit',
  editfile: 'Edit',
  strreplace: 'Edit',
  strreplaceeditor: 'Edit',
  replaceinfile: 'Edit',
  multiedit: 'Edit',
  bash: 'Bash',
  runcommand: 'Bash',
  shell: 'Bash',
  exec: 'Bash',
  terminal: 'Bash',
  run: 'Bash',
  glob: 'Glob',
  findfiles: 'Glob',
  listdir: 'Glob',
  listfiles: 'Glob',
  ls: 'Glob',
  grep: 'Grep',
  searchfiles: 'Grep',
  grepfiles: 'Grep',
  search: 'Grep',
  webfetch: 'WebFetch',
  fetch: 'WebFetch',
  fetchurl: 'WebFetch',
};

const WRAPPER_NAMES = new Set([
  'toolcall',
  'tool',
  'function',
  'call',
  'tooluse',
  'functioncall',
  'action',
  'invoke',
  'zeustool',
  'odtool',
  'opendesigntool',
  'xmltool',
]);

function squash(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function normalizeToolName(raw: string): string {
  return ALIASES[squash(raw)] ?? raw.trim();
}

/** Canonicalise argument keys so the web UI's fileOf / diffStat / commandOf always match. */
export function canonicalizeToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (name === 'Write' || name === 'Read' || name === 'Edit') {
    const fp = out.file_path ?? out.filePath ?? out.path ?? out.file ?? out.filename ?? out.target;
    if (typeof fp === 'string' && fp.trim()) {
      out.file_path = fp.trim();
    } else if (name === 'Write') {
      out.file_path = 'index.html';
    }
  }
  if (name === 'Write' && typeof out.content !== 'string') {
    const body = out.body ?? out.html ?? out.code ?? out.text ?? out.raw;
    if (typeof body === 'string') out.content = body;
  }
  if (name === 'Edit') {
    if (typeof out.old_string !== 'string' && typeof out.search === 'string') out.old_string = out.search;
    if (typeof out.new_string !== 'string' && typeof out.replace === 'string') out.new_string = out.replace;
  }
  if (name === 'Bash' && typeof out.command !== 'string' && typeof out.cmd === 'string') {
    out.command = out.cmd;
  }
  if ((name === 'Glob' || name === 'Grep') && typeof out.pattern !== 'string' && typeof out.query === 'string') {
    out.pattern = out.query;
  }
  return out;
}

/** Infer the intended tool from arguments when a model uses a wrapper tag name as the tool name. */
export function inferToolFromArgs(args: Record<string, unknown>): ParsedToolCall | null {
  if (Array.isArray(args.todos) || Array.isArray(args.plan) || Array.isArray(args.items)) {
    return { name: 'TodoWrite', arguments: { todos: args.todos ?? args.plan ?? args.items } };
  }
  const filePath = args.file_path ?? args.path ?? args.file ?? args.filename ?? args.target;
  if (typeof args.old_string === 'string' || typeof args.search === 'string') {
    return {
      name: 'Edit',
      arguments: {
        file_path: typeof filePath === 'string' && filePath ? filePath : 'index.html',
        old_string: String(args.old_string ?? args.search ?? ''),
        new_string: String(args.new_string ?? args.replace ?? args.content ?? ''),
      },
    };
  }
  if (typeof args.content === 'string' && args.content.trim().length > 0) {
    return {
      name: 'Write',
      arguments: {
        file_path: typeof filePath === 'string' && filePath ? filePath : 'index.html',
        content: args.content,
      },
    };
  }
  if (typeof args.command === 'string' || typeof args.cmd === 'string') {
    return {
      name: 'Bash',
      arguments: { command: String(args.command ?? args.cmd ?? '') },
    };
  }
  if (typeof args.url === 'string' && /^https?:\/\//i.test(args.url)) {
    return { name: 'WebFetch', arguments: { url: args.url } };
  }
  if (typeof args.pattern === 'string' || typeof args.query === 'string') {
    const pat = String(args.pattern ?? args.query ?? '');
    if (pat.includes('*') && !args.query) {
      return { name: 'Glob', arguments: { pattern: pat } };
    }
    return { name: 'Grep', arguments: { pattern: pat, path: String(args.path ?? '.') } };
  }
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    return { name: 'Read', arguments: { file_path: filePath.trim() } };
  }
  return null;
}

export function isKnownTool(name: string): boolean {
  return (SUPPORTED_TOOLS as readonly string[]).includes(name);
}

/** Escape raw control characters that appear inside JSON strings. */
function repairJsonText(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  if (inString) out += '"';
  // balance braces for truncated output
  let depth = 0;
  let str = false;
  let esc = false;
  const stack: string[] = [];
  for (const ch of out) {
    if (str) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') str = false;
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
    depth = stack.length;
  }
  if (depth > 0) out = out.replace(/,\s*$/, '') + stack.reverse().join('');
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function parseLooseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {}
  try {
    return JSON.parse(repairJsonText(trimmed));
  } catch {}
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const parsed = parseLooseJson(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { raw: value };
  }
  return {};
}

const META_KEYS = new Set(['name', 'tool', 'tool_name', 'toolName', 'type', 'id', 'function', 'arguments', 'input', 'parameters', 'params', 'args']);

/** Convert one decoded JSON value into zero or more calls. */
export function callsFromValue(value: unknown, depth = 0): ParsedToolCall[] {
  if (depth > 3 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v) => callsFromValue(v, depth + 1));
  if (typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;

  for (const key of ['tool_calls', 'toolCalls', 'calls']) {
    if (Array.isArray(obj[key])) return callsFromValue(obj[key], depth + 1);
  }
  for (const key of ['tool_call', 'toolCall', 'function_call', 'functionCall', 'tool_use']) {
    const inner = obj[key];
    if (inner && typeof inner === 'object') return callsFromValue(inner, depth + 1);
  }

  const fn = obj.function && typeof obj.function === 'object' ? (obj.function as Record<string, unknown>) : undefined;
  const rawName = String(
    (typeof obj.name === 'string' && obj.name) ||
      (typeof obj.tool === 'string' && obj.tool) ||
      (typeof obj.tool_name === 'string' && obj.tool_name) ||
      (typeof obj.toolName === 'string' && obj.toolName) ||
      (fn && typeof fn.name === 'string' && fn.name) ||
      (typeof obj.function === 'string' && obj.function) ||
      '',
  );
  if (!rawName) return [];

  const argSource = fn?.arguments ?? obj.arguments ?? obj.input ?? obj.parameters ?? obj.params ?? obj.args ?? fn?.parameters;
  let args = toRecord(argSource);
  if (argSource === undefined) {
    // flat form: {"name":"Write","file_path":"a.html","content":"..."}
    args = Object.fromEntries(Object.entries(obj).filter(([k]) => !META_KEYS.has(k)));
  }

  // wrapper form: {"name":"tool_call","arguments":{"name":"Write","arguments":{...}}}
  if (WRAPPER_NAMES.has(squash(rawName))) {
    const nested = callsFromValue(args, depth + 1);
    if (nested.length > 0) return nested;
    const innerName = args.name ?? args.tool ?? args.tool_name;
    if (typeof innerName === 'string' && innerName && !WRAPPER_NAMES.has(squash(innerName))) {
      const rest = toRecord(args.arguments ?? args.input ?? args.parameters ?? args.params ?? args.args);
      return [{ name: normalizeToolName(innerName), arguments: Object.keys(rest).length ? rest : args }];
    }
    const inferred = inferToolFromArgs(args);
    return inferred ? [inferred] : [];
  }
  const normalized = normalizeToolName(rawName);
  if (!isKnownTool(normalized)) {
    const inferred = inferToolFromArgs(args);
    if (inferred) return [inferred];
  }
  return [{ name: normalized, arguments: args }];
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) attrs[m[1]!] = m[2] ?? m[3] ?? '';
  return attrs;
}

function extractXmlParams(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const paramRe = /<(?:antml:)?parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?parameter>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(block)) !== null) out[pm[1]!] = pm[2]!;
  for (const tag of ['name', 'tool', 'path', 'file_path', 'file', 'content', 'old_string', 'new_string', 'command', 'pattern', 'query', 'url']) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = re.exec(block);
    if (m && !(tag in out)) out[tag] = m[1]!;
  }
  return out;
}

function callFromTagBody(attrs: Record<string, string>, bodyRaw: string, defaultName = ''): ParsedToolCall[] {
  const xmlParams = extractXmlParams(bodyRaw);
  const mergedAttrs: Record<string, string> = { ...xmlParams, ...attrs };
  const candidateName = mergedAttrs.name ?? mergedAttrs.tool ?? defaultName;
  const rawName = WRAPPER_NAMES.has(squash(candidateName)) ? defaultName : candidateName;
  const body = (mergedAttrs.content ?? bodyRaw).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const filePath = mergedAttrs.path ?? mergedAttrs.file_path ?? mergedAttrs.file ?? mergedAttrs.filename;
  if (!rawName) {
    const parsed = parseLooseJson(body);
    if (parsed !== undefined) {
      const calls = callsFromValue(parsed);
      if (calls.length > 0) return calls;
    }
    const salvaged = salvageWrite(body);
    if (salvaged) return [salvaged];
    if (/<(?:!doctype\s+html|html|head|body|svg)\b/i.test(body)) {
      return [{ name: 'Write', arguments: { file_path: filePath ?? 'index.html', content: body } }];
    }
    const inferred = inferToolFromArgs({ ...mergedAttrs, ...(body.trim() ? { content: body } : {}) });
    return inferred ? [inferred] : [];
  }
  const name = normalizeToolName(rawName);
  switch (name) {
    case 'Write':
      return [{ name, arguments: { file_path: filePath ?? 'index.html', content: body || mergedAttrs.content || '' } }];
    case 'Read':
      return [{ name, arguments: { file_path: filePath ?? body.trim() } }];
    case 'Edit': {
      const parsed = parseLooseJson(body);
      if (parsed && typeof parsed === 'object') {
        return [{ name, arguments: { file_path: filePath ?? '', ...(parsed as Record<string, unknown>) } }];
      }
      return [{ name, arguments: { file_path: filePath ?? '', old_string: mergedAttrs.search ?? mergedAttrs.old_string ?? '', new_string: mergedAttrs.replace ?? mergedAttrs.new_string ?? body } }];
    }
    case 'Bash':
      return [{ name, arguments: { command: mergedAttrs.command ?? mergedAttrs.cmd ?? body.trim() } }];
    case 'Glob':
      return [{ name, arguments: { pattern: mergedAttrs.pattern ?? mergedAttrs.path ?? (body.trim() || '*') } }];
    case 'Grep':
      return [{ name, arguments: { pattern: mergedAttrs.pattern ?? mergedAttrs.query ?? body.trim(), path: mergedAttrs.path ?? '.' } }];
    case 'WebFetch':
      return [{ name, arguments: { url: mergedAttrs.url ?? body.trim() } }];
    default: {
      const parsed = parseLooseJson(body);
      const extra = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : (body.trim() ? { content: body } : {});
      const combined = { ...mergedAttrs, ...extra };
      const inferred = inferToolFromArgs(combined);
      if (inferred) return [inferred];
      if (WRAPPER_NAMES.has(squash(name))) return [];
      return [{ name, arguments: combined }];
    }
  }
}

/** Last resort for a Write call whose JSON is broken by unescaped quotes. */
function salvageWrite(body: string): ParsedToolCall | undefined {
  if (/"(?:old_string|search)"\s*:/.test(body)) return undefined;
  const p = /"(?:file_path|path|file|filename)"\s*:\s*"([^"]+)"/.exec(body);
  const c = /"(?:content|body|html|code)"\s*:\s*"/.exec(body);
  if (!p || !c) return undefined;
  let content = body.slice(c.index + c[0].length).replace(/"\s*\}\s*\}?\s*$/, '');
  content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  return content.trim() ? { name: 'Write', arguments: { file_path: p[1]!, content } } : undefined;
}

const SHORTHAND_TOOL_TAGS =
  'Write|write_file|create_file|Edit|edit_file|Read|read_file|Bash|shell|run_command|Glob|list_dir|Grep|search_code|WebFetch|web_fetch|TodoWrite|todo_write';

export function extractToolCallsFromOutput(raw: string): { cleanedText: string; toolCalls: ParsedToolCall[] } {
  let text = raw;
  const rawCalls: ParsedToolCall[] = [];

  // Direct shorthand XML tags (<Write path="...">...</Write>, <Read path="..."/>, etc.)
  const shorthandRe = new RegExp(
    `<(${SHORTHAND_TOOL_TAGS})\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)(?:<\\/\\1\\s*>|$))`,
    'gi',
  );
  text = text.replace(shorthandRe, (_m, tagName: string, attrStr: string, body?: string) => {
    rawCalls.push(...callFromTagBody(parseAttributes(attrStr ?? ''), body ?? '', tagName));
    return '';
  });

  // <zeus_tool ...> / <od_tool ...> / <function_call ...>
  text = text.replace(
    /<(?:zeus_tool|od_tool|function_call)\b([^>]*?)(?:\/>|>([\s\S]*?)(?:<\/(?:zeus_tool|od_tool|function_call)\s*>|$))/gi,
    (_m, attrStr: string, body?: string) => {
      rawCalls.push(...callFromTagBody(parseAttributes(attrStr ?? ''), body ?? ''));
      return '';
    },
  );

  // <tool_call ...>BODY</tool_call>   (closed, or unclosed at end of output)
  text = text.replace(/<tool_call\b([^>]*)>([\s\S]*?)(?:<\/tool_call\s*>|$)/gi, (_m, attrStr: string, inner: string) => {
    const attrs = parseAttributes(attrStr ?? '');
    const body = inner.trim();
    const parsed = parseLooseJson(body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    if (parsed !== undefined) {
      const calls = callsFromValue(parsed);
      if (calls.length > 0) {
        rawCalls.push(...calls);
        return '';
      }
    }
    const salvaged = salvageWrite(body);
    if (salvaged) {
      rawCalls.push(salvaged);
      return '';
    }
    rawCalls.push(...callFromTagBody(attrs, inner));
    return '';
  });

  // Anthropic-style <invoke name="...">...</invoke>, optionally inside <function_calls>
  text = text.replace(/<(?:antml:)?invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:antml:)?invoke>/gi, (_m, rawName: string, block: string) => {
    const args = extractXmlParams(block);
    rawCalls.push(...callsFromValue({ name: rawName, arguments: args }));
    return '';
  });
  text = text.replace(/<\/?(?:antml:)?function_calls>/gi, '');

  // ```json / ```tool_call fenced JSON that is clearly a tool call
  text = text.replace(/```(?:json|tool_call|tool|tool_code)?[ \t]*\r?\n([\s\S]*?)```/gi, (full, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return full;
    const parsed = parseLooseJson(trimmed);
    const calls = parsed !== undefined ? callsFromValue(parsed) : (salvageWrite(trimmed) ? [salvageWrite(trimmed)!] : []);
    const valid = calls.filter((c) => isKnownTool(c.name));
    if (valid.length === 0) return full;
    rawCalls.push(...valid);
    return '';
  });

  // A bare JSON object on its own line carrying a known tool name
  text = text.replace(/^[ \t]*(\{\s*"(?:name|tool)"\s*:\s*"[^"]+"[\s\S]*?\})[ \t]*$/gm, (full, inner: string) => {
    const parsed = parseLooseJson(inner);
    const calls = parsed !== undefined ? callsFromValue(parsed) : (salvageWrite(inner) ? [salvageWrite(inner)!] : []);
    const valid = calls.filter((c) => isKnownTool(c.name));
    if (valid.length === 0) return full;
    rawCalls.push(...valid);
    return '';
  });

  // Final normalisation pass: never emit a wrapper tag name (e.g. zeus_tool / tool_call)
  const toolCalls: ParsedToolCall[] = [];
  for (const call of rawCalls) {
    const norm = normalizeToolName(call.name);
    if (isKnownTool(norm)) {
      toolCalls.push({ name: norm, arguments: canonicalizeToolArgs(norm, call.arguments) });
      continue;
    }
    const inferred = inferToolFromArgs(call.arguments);
    if (inferred) {
      toolCalls.push({ name: inferred.name, arguments: canonicalizeToolArgs(inferred.name, inferred.arguments) });
      continue;
    }
    if (!WRAPPER_NAMES.has(squash(norm))) {
      toolCalls.push({ name: norm, arguments: call.arguments });
    }
  }

  return { cleanedText: text.trim(), toolCalls };
}

/* ------------------------------------------------------------------ */
/* Live stream splitter                                                */
/* ------------------------------------------------------------------ */

interface HiddenRule {
  open: RegExp;
  close: RegExp;
}

const HIDDEN_RULES: HiddenRule[] = [
  { open: /^<Write\b[^>]*>/i, close: /<\/Write\s*>/i },
  { open: /^<write_file\b[^>]*>/i, close: /<\/write_file\s*>/i },
  { open: /^<Edit\b[^>]*>/i, close: /<\/Edit\s*>/i },
  { open: /^<Read\b[^>]*>/i, close: /<\/Read\s*>/i },
  { open: /^<Bash\b[^>]*>/i, close: /<\/Bash\s*>/i },
  { open: /^<TodoWrite\b[^>]*>/i, close: /<\/TodoWrite\s*>/i },
  { open: /^<tool_call\b[^>]*>/i, close: /<\/tool_call\s*>/i },
  { open: /^<zeus_tool\b[^>]*>/i, close: /<\/zeus_tool\s*>/i },
  { open: /^<od_tool\b[^>]*>/i, close: /<\/od_tool\s*>/i },
  { open: /^<function_calls>/i, close: /<\/function_calls>/i },
  { open: /^<(?:antml:)?invoke\b[^>]*>/i, close: /<\/(?:antml:)?invoke>/i },
  { open: /^<artifact\b[^>]*>/i, close: /<\/artifact\s*>/i },
  { open: /^<artboard\b[^>]*>/i, close: /<\/artboard\s*>/i },
  { open: /^```(?:html|json|tool_call|tool)[^\n]*\n/i, close: /```/ },
];

const HIDDEN_PREFIXES = [
  '<write',
  '<edit',
  '<read',
  '<bash',
  '<todowrite',
  '<tool_call',
  '<zeus_tool',
  '<od_tool',
  '<function_calls',
  '<invoke',
  '<antml:invoke',
  '<artifact',
  '<artboard',
  '```',
];

/**
 * Splits streamed model output into thinking text, visible prose, and hidden
 * spans (tool calls / raw artifacts) so the UI updates live without leaking
 * protocol markup. Hidden spans are retained for post-processing.
 */
export class StreamSplitter {
  private buf = '';
  private mode: 'text' | 'think' | 'hidden' = 'text';
  private hiddenClose: RegExp | null = null;
  private hiddenBuf = '';
  readonly hiddenSpans: string[] = [];
  visibleEmitted = false;

  constructor(
    private readonly onText: (s: string) => void,
    private readonly onThink: (s: string) => void,
  ) {}

  private emitText(s: string): void {
    if (!s) return;
    if (!this.visibleEmitted && !s.trim()) return;
    this.visibleEmitted = true;
    this.onText(s);
  }

  feed(chunk: string): void {
    this.buf += chunk;
    this.drain(false);
  }

  end(): void {
    this.drain(true);
    if (this.mode === 'hidden' && this.hiddenBuf) this.hiddenSpans.push(this.hiddenBuf);
    this.hiddenBuf = '';
    this.mode = 'text';
  }

  private drain(final: boolean): void {
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.mode === 'think') {
        const m = /<\/think>/i.exec(this.buf);
        if (m) {
          this.onThink(this.buf.slice(0, m.index));
          this.buf = this.buf.slice(m.index + m[0].length);
          this.mode = 'text';
          continue;
        }
        const keep = final ? 0 : this.partialSuffix(this.buf, '</think>');
        const out = this.buf.slice(0, this.buf.length - keep);
        if (out) this.onThink(out);
        this.buf = this.buf.slice(this.buf.length - keep);
        return;
      }
      if (this.mode === 'hidden') {
        const m = this.hiddenClose!.exec(this.buf);
        if (m) {
          this.hiddenBuf += this.buf.slice(0, m.index + m[0].length);
          this.hiddenSpans.push(this.hiddenBuf);
          this.hiddenBuf = '';
          this.buf = this.buf.slice(m.index + m[0].length);
          this.mode = 'text';
          continue;
        }
        // keep a tail so a split closing tag is still detected
        const keep = final ? 0 : Math.min(this.buf.length, 16);
        this.hiddenBuf += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        if (final) {
          this.hiddenBuf += this.buf;
          this.buf = '';
        }
        return;
      }
      // text mode
      const lt = this.nextSpecial(this.buf);
      if (lt < 0) {
        this.emitText(this.buf);
        this.buf = '';
        return;
      }
      this.emitText(this.buf.slice(0, lt));
      this.buf = this.buf.slice(lt);
      const think = /^<think>/i.exec(this.buf);
      if (think) {
        this.buf = this.buf.slice(think[0].length);
        this.mode = 'think';
        continue;
      }
      const rule = HIDDEN_RULES.find((r) => r.open.test(this.buf));
      if (rule) {
        const m = rule.open.exec(this.buf)!;
        this.hiddenBuf = m[0];
        this.buf = this.buf.slice(m[0].length);
        this.hiddenClose = rule.close;
        this.mode = 'hidden';
        continue;
      }
      const lower = this.buf.toLowerCase();
      const couldBeTag =
        !final &&
        (('<think>'.startsWith(lower) || lower.startsWith('<think')) && !lower.includes('>')
          ? true
          : HIDDEN_PREFIXES.some((p) => p.startsWith(lower) || (lower.startsWith(p) && !lower.includes('>') && p !== '```')) ||
            (lower.startsWith('```') && !lower.includes('\n')));
      if (couldBeTag) return;
      // not a special tag: emit one char and move on
      this.emitText(this.buf[0]!);
      this.buf = this.buf.slice(1);
    }
  }

  private nextSpecial(s: string): number {
    const a = s.indexOf('<');
    const b = s.indexOf('```');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }

  private partialSuffix(s: string, tag: string): number {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > 0; n--) {
      if (tag.toLowerCase().startsWith(s.slice(s.length - n).toLowerCase())) return n;
    }
    return 0;
  }
}
