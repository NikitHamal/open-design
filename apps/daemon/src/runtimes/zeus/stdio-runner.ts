import { exec, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import {
  PROVIDERS,
  type ZeusChatMessage,
  type ZeusCustomEndpoint,
  reasoningTiers,
} from './catalog.js';
import { streamZeusProvider } from './scrapers.js';
import {
  StreamSplitter,
  SUPPORTED_TOOLS,
  canonicalizeToolArgs,
  extractToolCallsFromOutput,
  inferToolFromArgs,
  isKnownTool,
  normalizeToolName,
  type ParsedToolCall,
} from './tool-parser.js';

export { extractToolCallsFromOutput };

const execAsync = promisify(exec);

const ZEUS_BRIDGE_SYSTEM_PROMPT = [
  'You are OpenDesign, a design and coding agent with full access to the project workspace through tools.',
  '',
  'DESIGN LAWS (apply to every screen you produce):',
  '- No box shadows. Use box-shadow: none and separate surfaces with tonal fills and 1px borders.',
  '- No emojis in UI copy, headings, badges or chat replies.',
  '- No "LIVE" badges. No blue or purple gradients.',
  '- Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.',
  "- Typography: 'Google Sans Flex' for UI, display and body; 'Roboto Mono' for code.",
  '- Keep text contrast at WCAG AA or better in both light and dark surfaces.',
  '',
  'TOOLS. To act on the workspace, emit a tool block in your reply. The host executes it and returns a <tool_result> message, then you continue.',
  '',
  'Create or overwrite a file (write the raw file body directly inside <Write>, no JSON escaping needed):',
  '<Write path="landing.html">',
  '<!DOCTYPE html>',
  '...complete self-contained file...',
  '</Write>',
  '',
  'Other workspace tools use one JSON object per <tool_call> block on a single line:',
  '<tool_call>{"name":"Read","arguments":{"file_path":"landing.html"}}</tool_call>',
  '<tool_call>{"name":"Edit","arguments":{"file_path":"landing.html","old_string":"exact old text","new_string":"new text"}}</tool_call>',
  '<tool_call>{"name":"Bash","arguments":{"command":"ls -la"}}</tool_call>',
  '<tool_call>{"name":"Glob","arguments":{"pattern":"**/*.html"}}</tool_call>',
  '<tool_call>{"name":"Grep","arguments":{"pattern":"function","path":"."}}</tool_call>',
  '<tool_call>{"name":"WebFetch","arguments":{"url":"https://example.com"}}</tool_call>',
  '<tool_call>{"name":"TodoWrite","arguments":{"todos":[{"id":"1","content":"Build layout","status":"in_progress"}]}}</tool_call>',
  '',
  'Rules:',
  '- Valid tool names are ONLY: Write, Read, Edit, Bash, Glob, Grep, WebFetch, TodoWrite.',
  '- Every design, prototype, slide deck or video must be saved with Write as a complete self-contained file in the project directory, using a semantic relative path such as landing.html.',
  '- Never say a file was created or changed unless its <tool_result> reported success. If a result is an error, fix the call and retry.',
  '- After the last tool result, reply with a short plain-language summary and no tool block.',
].join('\n');

type FrameWriter = (frame: Record<string, unknown>) => void;

const defaultWriteFrame: FrameWriter = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

function parseXmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    attrs[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

function safeResolveInCwd(cwd: string, targetPath: string): string {
  const cleaned = targetPath.trim().replace(/^[/\\]+/, '');
  const resolved = path.resolve(cwd, cleaned || '.');
  const normalizedCwd = path.resolve(cwd);
  if (!resolved.startsWith(normalizedCwd)) {
    return path.join(normalizedCwd, path.basename(cleaned || 'artifact.html'));
  }
  return resolved;
}

async function executeLocalTool(
  cwd: string,
  rawCall: ParsedToolCall,
): Promise<{ output: string; isError: boolean; wroteFile?: string }> {
  let normName = normalizeToolName(rawCall.name);
  let normArgs = rawCall.arguments;
  if (!isKnownTool(normName)) {
    const inferred = inferToolFromArgs(normArgs);
    if (inferred) {
      normName = inferred.name;
      normArgs = inferred.arguments;
    }
  }
  const call: ParsedToolCall = {
    name: normName,
    arguments: canonicalizeToolArgs(normName, normArgs),
  };
  try {
    switch (call.name) {
      case 'TodoWrite': {
        const todos = Array.isArray(call.arguments.todos) ? call.arguments.todos : [];
        return {
          output: JSON.stringify({ ok: true, count: todos.length, todos }),
          isError: false,
        };
      }
      case 'Write': {
        const relPath = String(
          call.arguments.file_path ?? call.arguments.path ?? call.arguments.file ?? 'index.html',
        );
        const content = String(call.arguments.content ?? '');
        if (!content.trim()) return { output: 'Write needs non-empty content. Resend with the complete file body.', isError: true };
        const fullPath = safeResolveInCwd(cwd, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        const relOut = path.relative(cwd, fullPath).replace(/\\/g, '/');
        return {
          output: `Wrote ${content.length} bytes to ${relOut}`,
          isError: false,
          wroteFile: relOut,
        };
      }
      case 'Read': {
        const relPath = String(
          call.arguments.file_path ?? call.arguments.path ?? call.arguments.file ?? '',
        );
        const fullPath = safeResolveInCwd(cwd, relPath);
        if (!fs.existsSync(fullPath)) {
          return { output: `File not found: ${relPath}`, isError: true };
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(fullPath);
          return { output: entries.join('\n'), isError: false };
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        return { output: content.slice(0, 32000), isError: false };
      }
      case 'Edit': {
        const relPath = String(
          call.arguments.file_path ?? call.arguments.path ?? call.arguments.file ?? '',
        );
        const oldStr = String(call.arguments.old_string ?? call.arguments.search ?? '');
        const newStr = String(call.arguments.new_string ?? call.arguments.replace ?? '');
        const fullPath = safeResolveInCwd(cwd, relPath);
        if (!fs.existsSync(fullPath)) {
          return { output: `File not found: ${relPath}`, isError: true };
        }
        const current = fs.readFileSync(fullPath, 'utf8');
        if (oldStr && current.includes(oldStr)) {
          const updated = current.replace(oldStr, newStr);
          fs.writeFileSync(fullPath, updated, 'utf8');
          const relOut = path.relative(cwd, fullPath).replace(/\\/g, '/');
          return { output: `Updated ${relOut}`, isError: false, wroteFile: relOut };
        }
        return { output: `old_string not found in ${relPath}`, isError: true };
      }
      case 'Glob': {
        const entries: string[] = [];
        const walk = (dir: string, depth = 0) => {
          if (depth > 4 || entries.length >= 200) return;
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (item.name.startsWith('.git') || item.name === 'node_modules') continue;
            const full = path.join(dir, item.name);
            const rel = path.relative(cwd, full).replace(/\\/g, '/');
            if (item.isDirectory()) {
              walk(full, depth + 1);
            } else {
              entries.push(rel);
            }
          }
        };
        walk(cwd);
        return { output: entries.join('\n') || '(empty directory)', isError: false };
      }
      case 'Grep': {
        const pattern = String(call.arguments.pattern ?? call.arguments.query ?? '');
        if (!pattern) return { output: 'Empty pattern', isError: false };
        const re = new RegExp(pattern, 'i');
        const matches: string[] = [];
        const walk = (dir: string, depth = 0) => {
          if (depth > 3 || matches.length >= 80) return;
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (item.name.startsWith('.') || item.name === 'node_modules') continue;
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
              walk(full, depth + 1);
            } else {
              try {
                const txt = fs.readFileSync(full, 'utf8');
                const lines = txt.split('\n');
                lines.forEach((line, idx) => {
                  if (matches.length < 80 && re.test(line)) {
                    const rel = path.relative(cwd, full).replace(/\\/g, '/');
                    matches.push(`${rel}:${idx + 1}: ${line.slice(0, 160)}`);
                  }
                });
              } catch {}
            }
          }
        };
        walk(cwd);
        return { output: matches.join('\n') || 'No matches found', isError: false };
      }
      case 'Bash': {
        const cmd = String(call.arguments.command ?? '');
        if (!cmd.trim()) return { output: '', isError: false };
        const { stdout, stderr } = await execAsync(cmd, {
          cwd,
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return {
          output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim().slice(0, 16000),
          isError: false,
        };
      }
      case 'WebFetch': {
        const url = String(call.arguments.url ?? call.arguments.raw ?? '');
        if (!/^https?:\/\//i.test(url)) return { output: 'WebFetch needs an absolute http(s) url', isError: true };
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0' } });
        const body = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
        return { output: `HTTP ${res.status}\n${body.slice(0, 16000)}`, isError: !res.ok };
      }
      default:
        return {
          output: `Unknown tool "${call.name}". Use one of: ${SUPPORTED_TOOLS.join(', ')}. Resend the call with a valid name.`,
          isError: true,
        };
    }
  } catch (err) {
    return {
      output: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * If a keyless web scraper output one or more HTML artifacts directly in prose
 * (<artifact>, <artboard>, or ```html <!DOCTYPE html>...```) without invoking Write,
 * extract and materialize all of them into the project workspace automatically.
 */
function extractFallbackHtmlArtifacts(raw: string): {
  artifacts: Array<{ filename: string; html: string }>;
  cleanedProse: string;
} {
  let cleanedProse = raw;
  const artifacts: Array<{ filename: string; html: string }> = [];
  const usedNames = new Set<string>();

  const uniqueName = (base: string): string => {
    const clean = base.endsWith('.html') ? base : `${base}.html`;
    if (!usedNames.has(clean)) {
      usedNames.add(clean);
      return clean;
    }
    const stem = clean.slice(0, -5);
    let idx = 2;
    while (usedNames.has(`${stem}-${idx}.html`)) idx++;
    const next = `${stem}-${idx}.html`;
    usedNames.add(next);
    return next;
  };

  // 1. <artifact ...>...</artifact>
  const artRe = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi;
  cleanedProse = cleanedProse.replace(artRe, (full, attrStr: string, bodyRaw: string) => {
    const attrs = parseXmlAttributes(attrStr ?? '');
    const body = (bodyRaw ?? '').trim();
    if (body.includes('<html') || body.includes('<!doctype') || body.includes('<!DOCTYPE') || body.includes('<body')) {
      const rawName = attrs.file || attrs.path || attrs.title?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'design-preview';
      artifacts.push({ filename: uniqueName(rawName), html: body });
      return '';
    }
    return full;
  });

  // 2. <artboard ...>...</artboard>
  const abRe = /<artboard\b([^>]*)>([\s\S]*?)<\/artboard>/gi;
  cleanedProse = cleanedProse.replace(abRe, (full, attrStr: string, bodyRaw: string) => {
    const attrs = parseXmlAttributes(attrStr ?? '');
    const body = (bodyRaw ?? '').trim();
    if (body.length > 80) {
      const rawName = attrs.file || attrs.path || attrs.name || 'screen';
      const slug = rawName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'screen';
      const html = body.includes('<html') || body.includes('<!DOCTYPE') || body.includes('<!doctype')
        ? body
        : `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<title>${attrs.name || 'Design'}</title>\n</head>\n<body>\n${body}\n</body>\n</html>`;
      artifacts.push({ filename: uniqueName(slug), html });
      return '';
    }
    return full;
  });

  // 3. ```html ... ```
  const fenceRe = /```html(?:\s+([^\r\n]*))?\r?\n([\s\S]*?)```/gi;
  cleanedProse = cleanedProse.replace(fenceRe, (full, fenceMeta: string, bodyRaw: string) => {
    const body = (bodyRaw ?? '').trim();
    if (
      body.length > 160 &&
      (body.includes('<!DOCTYPE html') || body.includes('<!doctype html') || body.includes('<html'))
    ) {
      const metaAttrs = parseXmlAttributes(fenceMeta ?? '');
      const titleMatch = /<title>([^<]+)<\/title>/i.exec(body);
      const slug = metaAttrs.file || metaAttrs.filename || metaAttrs.path || (titleMatch?.[1]
        ? titleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42)
        : 'design-preview');
      artifacts.push({ filename: uniqueName(slug || 'design-preview'), html: body });
      return '';
    }
    return full;
  });

  return { artifacts, cleanedProse: cleanedProse.trim() };
}

function sessionStorePath(cwd: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.od', 'zeus-sessions', `${safeId}.json`);
}

function loadSessionHistory(cwd: string, sessionId: string): ZeusChatMessage[] {
  try {
    const file = sessionStorePath(cwd, sessionId);
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveSessionHistory(cwd: string, sessionId: string, messages: ZeusChatMessage[]): void {
  try {
    const file = sessionStorePath(cwd, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(messages.slice(-24)), 'utf8');
  } catch {}
}

function parseCustomEndpointFromEnv(env?: NodeJS.ProcessEnv): { custom: ZeusCustomEndpoint; model?: string } | null {
  const raw = env?.OD_ZEUS_CUSTOM_PROVIDER?.trim() || process.env.OD_ZEUS_CUSTOM_PROVIDER?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      protocol?: string;
      format?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
    };
    if (!parsed.baseUrl) return null;
    const format: 'openai' | 'anthropic' =
      parsed.format === 'anthropic' || parsed.protocol === 'anthropic' ? 'anthropic' : 'openai';
    return {
      custom: {
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey ?? '',
        format,
      },
      ...(parsed.model ? { model: parsed.model } : {}),
    };
  } catch {
    return null;
  }
}

async function handleExecuteCommand(
  cmd: {
    request_id: string;
    cwd: string;
    prompt: string;
    resume_session_id?: string;
    model?: { provider: string; id: string };
    reasoning_effort?: string;
  },
  signal: AbortSignal,
  writeFrame: FrameWriter = defaultWriteFrame,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const requestId = cmd.request_id;
  const cwd = cmd.cwd || process.cwd();
  const sessionId = cmd.resume_session_id || randomUUID();
  const resumed = Boolean(cmd.resume_session_id);

  writeFrame({
    v: 1,
    type: 'session',
    request_id: requestId,
    session_id: sessionId,
    resumed,
  });

  const customFromEnv = parseCustomEndpointFromEnv(env);
  const provider = cmd.model?.provider || 'mercury3';
  const modelId = customFromEnv?.model || cmd.model?.id || 'mercury-3';
  const effort = cmd.reasoning_effort || 'medium';

  const doneKeyMatch = /<od-done\s+key="([^"]+)"/i.exec(cmd.prompt);
  const doneKey = doneKeyMatch?.[1] ?? '';
  const wantsTitleMarker = cmd.prompt.includes('<od-title>');

  let userPromptText = cmd.prompt;
  let rawInstructions = '';
  let extraSystemContext = '';
  const xmlPromptMatch = /<user_first_prompt>([\s\S]*?)<\/user_first_prompt>/i.exec(cmd.prompt);
  const resumedRequestMarker = '\nCurrent user request:\n';
  const userRequestMarker = '\n# User request\n\n';
  const markerIdx = cmd.prompt.lastIndexOf(userRequestMarker);
  const resumedIdx = cmd.prompt.lastIndexOf(resumedRequestMarker);

  if (xmlPromptMatch) {
    rawInstructions = cmd.prompt.slice(0, xmlPromptMatch.index);
    userPromptText = xmlPromptMatch[1]!.trim();
  } else if (markerIdx !== -1) {
    rawInstructions = cmd.prompt.slice(0, markerIdx);
    userPromptText = cmd.prompt.slice(markerIdx + userRequestMarker.length).trim();
  } else if (resumedIdx !== -1) {
    rawInstructions = cmd.prompt.slice(0, resumedIdx);
    userPromptText = cmd.prompt.slice(resumedIdx + resumedRequestMarker.length).trim();
  }

  if (rawInstructions) {
    const dsMatch = /(?:## Design System|# Design System|## Visual Direction)[\s\S]{0,4000}/i.exec(rawInstructions);
    if (dsMatch) {
      extraSystemContext += `\n\n${dsMatch[0].trim()}`;
    }
    const localeMatch = /# UI locale override[\s\S]{0,1200}/i.exec(rawInstructions);
    if (localeMatch) {
      extraSystemContext += `\n\n${localeMatch[0].trim()}`;
    }
  }
  if (wantsTitleMarker && !resumed) {
    extraSystemContext += '\n\nBefore answering the user request, emit one short title marker: <od-title>2-5 Word Title</od-title>';
  }

  const effectiveSystemPrompt = `${ZEUS_BRIDGE_SYSTEM_PROMPT}${extraSystemContext}`;

  const history = resumed ? loadSessionHistory(cwd, sessionId) : [];
  const messages: ZeusChatMessage[] = [
    ...history,
    { role: 'user', content: userPromptText || cmd.prompt },
  ];

  const wroteFiles: string[] = [];
  let totalInputChars = (userPromptText || cmd.prompt).length;
  let totalOutputChars = 0;
  const MAX_ROUNDS = 6;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) {
        writeFrame({
          v: 1,
          type: 'result',
          request_id: requestId,
          status: 'cancelled',
          session_id: sessionId,
          resume_rejected: false,
        });
        return;
      }

      let roundRawText = '';
      const splitter = new StreamSplitter(
        (text) =>
          writeFrame({ v: 1, type: 'text', request_id: requestId, content: text }),
        (think) => {
          if (think) writeFrame({ v: 1, type: 'thinking', request_id: requestId, content: think });
        },
      );

      await streamZeusProvider(
        {
          requestId: `${requestId}-r${round}`,
          provider,
          model: modelId,
          effort,
          system: effectiveSystemPrompt,
          messages,
          workspaceRoot: cwd,
          ...(customFromEnv ? { custom: customFromEnv.custom } : {}),
        },
        (delta) => {
          roundRawText += delta;
          totalOutputChars += delta.length;
          splitter.feed(delta);
        },
        (reasoningDelta) => {
          if (reasoningDelta) {
            writeFrame({
              v: 1,
              type: 'thinking',
              request_id: requestId,
              content: reasoningDelta,
            });
          }
        },
        signal,
      );
      splitter.end();

      // Strip <think>...</think> before parsing tool calls and final text
      const withoutThink = roundRawText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
      const { cleanedText, toolCalls } = extractToolCallsFromOutput(withoutThink);

      if (toolCalls.length > 0) {
        if (splitter.visibleEmitted) {
          writeFrame({ v: 1, type: 'text', request_id: requestId, content: '\n\n' });
        }
        messages.push({ role: 'assistant', content: withoutThink });
        const toolResultsSummary: string[] = [];

        for (const tc of toolCalls) {
          const callId = `call_${randomUUID().slice(0, 12)}`;
          writeFrame({
            v: 1,
            type: 'tool_call',
            request_id: requestId,
            call_id: callId,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
          const res = await executeLocalTool(cwd, tc);
          if (res.wroteFile) wroteFiles.push(res.wroteFile);
          writeFrame({
            v: 1,
            type: 'tool_result',
            request_id: requestId,
            call_id: callId,
            name: tc.name,
            output: res.output,
            is_error: res.isError,
          });
          toolResultsSummary.push(
            `<tool_result name="${tc.name}" ok="${!res.isError}">\n${res.output}\n</tool_result>`,
          );
        }

        messages.push({
          role: 'user',
          content: `Tool execution results:\n${toolResultsSummary.join('\n\n')}\nContinue and provide the final response once all files are ready.`,
        });
        totalInputChars += toolResultsSummary.join('').length;
        continue;
      }

      // Check if scraper emitted raw HTML artifact(s) without calling Write
      const fallback = wroteFiles.length === 0
        ? extractFallbackHtmlArtifacts(cleanedText)
        : { artifacts: [], cleanedProse: cleanedText };
      // Visible prose was already streamed live; only append what the splitter hid.
      let finalVisibleText = '';
      if (fallback.artifacts.length > 0) {
        for (const art of fallback.artifacts) {
          const callId = `call_${randomUUID().slice(0, 12)}`;
          const writeArgs = {
            file_path: art.filename,
            content: art.html,
          };
          writeFrame({
            v: 1,
            type: 'tool_call',
            request_id: requestId,
            call_id: callId,
            name: 'Write',
            arguments: JSON.stringify(writeArgs),
          });
          const res = await executeLocalTool(cwd, { name: 'Write', arguments: writeArgs });
          if (res.wroteFile) wroteFiles.push(res.wroteFile);
          writeFrame({
            v: 1,
            type: 'tool_result',
            request_id: requestId,
            call_id: callId,
            name: 'Write',
            output: res.output,
            is_error: res.isError,
          });
        }
        if (!splitter.visibleEmitted) {
          finalVisibleText = `Created ${fallback.artifacts.map((a) => `\`${a.filename}\``).join(', ')}.`;
        }
      } else if (splitter.hiddenSpans.length > 0) {
        // Hidden spans that were neither tool calls nor artifacts: show them as-is.
        finalVisibleText = splitter.hiddenSpans.join('\n');
      }

      // The model claims a file change but nothing was written: push it to actually do it.
      const claimsWrite =
        wroteFiles.length === 0 &&
        fallback.artifacts.length === 0 &&
        round < MAX_ROUNDS - 1 &&
        /\b(created|saved|wrote|written|updated|generated|built)\b[^.\n]{0,80}\.(html?|css|js|svg|md)\b/i.test(cleanedText);
      if (claimsWrite) {
        messages.push({ role: 'assistant', content: withoutThink });
        messages.push({
          role: 'user',
          content:
            'Host notice: no file was written. Nothing exists on disk yet. Emit the complete file now with <Write path="FILE.html">...</Write>, then summarise.',
        });
        continue;
      }

      const savedAssistantText = cleanedText || finalVisibleText;
      if (doneKey) {
        if (wroteFiles.length > 0 && !cleanedText.includes('<od-focus')) {
          finalVisibleText += `\n<od-focus key="${doneKey}" open="${wroteFiles[wroteFiles.length - 1]}"/>`;
        }
        if (!cleanedText.includes('<od-done') && !cleanedText.includes('<question-form')) {
          finalVisibleText += `\n<od-done key="${doneKey}"/>`;
        }
      }

      if (finalVisibleText) {
        writeFrame({
          v: 1,
          type: 'text',
          request_id: requestId,
          content: finalVisibleText,
        });
      }

      messages.push({ role: 'assistant', content: savedAssistantText });
      saveSessionHistory(cwd, sessionId, messages);
      break;
    }

    writeFrame({
      v: 1,
      type: 'usage',
      request_id: requestId,
      provider,
      model: modelId,
      input_tokens: Math.max(1, Math.round(totalInputChars / 4)),
      output_tokens: Math.max(1, Math.round(totalOutputChars / 4)),
    });

    writeFrame({
      v: 1,
      type: 'result',
      request_id: requestId,
      status: 'completed',
      session_id: sessionId,
      resume_rejected: false,
    });
  } catch (err) {
    if (signal.aborted) {
      writeFrame({
        v: 1,
        type: 'result',
        request_id: requestId,
        status: 'cancelled',
        session_id: sessionId,
        resume_rejected: false,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeFrame({
      v: 1,
      type: 'result',
      request_id: requestId,
      status: 'failed',
      session_id: sessionId,
      resume_rejected: false,
      error: {
        code: 'ZEUS_PROVIDER_ERROR',
        message,
      },
    });
  }
}

/**
 * In-process ChildProcess adapter for Zeus Engine.
 * Avoids spawning a second Electron/Node OS process per turn — zero extra RAM,
 * zero cold-start latency, and 100% standalone across packaged and dev builds.
 */
export function spawnInProcessZeusChild(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ChildProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  let exited = false;

  const state = {
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null] as ChildProcess['stdio'],
    pid: undefined,
    connected: false,
    get killed() { return state.killed; },
    get exitCode() { return state.exitCode; },
    get signalCode() { return state.signalCode; },
    spawnargs: [] as string[],
    spawnfile: 'zeus-builtin',
    kill(signal?: NodeJS.Signals | number): boolean {
      state.killed = true;
      controller.abort();
      finishExit(0, typeof signal === 'string' ? signal : null);
      return true;
    },
    ref() { return child; },
    unref() { return child; },
  }) as unknown as ChildProcess;

  const writeFrame: FrameWriter = (frame) => {
    if (!stdout.destroyed && stdout.writable) {
      stdout.write(`${JSON.stringify(frame)}\n`);
    }
  };

  const finishExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    state.exitCode = code;
    state.signalCode = signal;
    setImmediate(() => {
      try { stdout.end(); } catch {}
      try { stderr.end(); } catch {}
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    });
  };

  const rl = readline.createInterface({
    input: stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const cmd = JSON.parse(trimmed) as {
        type?: string;
        request_id?: string;
        cwd?: string;
        prompt?: string;
        resume_session_id?: string;
        model?: { provider: string; id: string };
        reasoning_effort?: string;
      };
      if (cmd.type === 'cancel') {
        controller.abort();
        return;
      }
      if (cmd.type === 'execute' && cmd.request_id) {
        void handleExecuteCommand(
          {
            request_id: cmd.request_id,
            cwd: cmd.cwd ?? options.cwd ?? process.cwd(),
            prompt: cmd.prompt ?? '',
            ...(cmd.resume_session_id ? { resume_session_id: cmd.resume_session_id } : {}),
            ...(cmd.model ? { model: cmd.model } : {}),
            ...(cmd.reasoning_effort ? { reasoning_effort: cmd.reasoning_effort } : {}),
          },
          controller.signal,
          writeFrame,
          options.env,
        ).finally(() => {
          rl.close();
          finishExit(0, null);
        });
      }
    } catch {}
  });

  setImmediate(() => {
    child.emit('spawn');
    writeFrame({
      v: 1,
      type: 'ready',
      runtime: 'open-design',
      protocol_version: 1,
      plugin_version: '1.0.0',
      capabilities: {
        session_resume: true,
        session_cancel: true,
        structured_events: true,
      },
    });
  });

  return child;
}

export async function runZeusStdioCli(argv: string[]): Promise<void> {
  if (argv.includes('--probe')) {
    defaultWriteFrame({
      v: 1,
      type: 'probe',
      runtime: 'open-design',
      protocol_version: 1,
      plugin_version: '1.0.0',
      capabilities: {
        session_resume: true,
        session_cancel: true,
        structured_events: true,
      },
    });
    return;
  }

  if (argv.includes('--models')) {
    const models = PROVIDERS.flatMap((p) =>
      p.models.map((m) => {
        const tiers = reasoningTiers(m);
        return {
          provider: p.id,
          provider_name: p.name,
          id: m.id,
          name: m.label,
          ...(tiers.length > 0
            ? {
                reasoning_options: tiers.map((t) => ({
                  id: t,
                  name: t === 'low' ? 'Low' : t === 'medium' ? 'Medium' : t === 'high' ? 'High' : 'Max',
                  ...(t === 'medium' ? { default: true } : {}),
                })),
              }
            : {}),
        };
      }),
    );
    defaultWriteFrame({
      v: 1,
      type: 'models',
      runtime: 'open-design',
      models,
    });
    return;
  }

  // Default: --stdio interactive JSONL session
  defaultWriteFrame({
    v: 1,
    type: 'ready',
    runtime: 'open-design',
    protocol_version: 1,
    plugin_version: '1.0.0',
    capabilities: {
      session_resume: true,
      session_cancel: true,
      structured_events: true,
    },
  });

  const controller = new AbortController();
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const cmd = JSON.parse(trimmed) as {
        type?: string;
        request_id?: string;
        cwd?: string;
        prompt?: string;
        resume_session_id?: string;
        model?: { provider: string; id: string };
        reasoning_effort?: string;
      };
      if (cmd.type === 'cancel') {
        controller.abort();
        return;
      }
      if (cmd.type === 'execute' && cmd.request_id) {
        void handleExecuteCommand(
          {
            request_id: cmd.request_id,
            cwd: cmd.cwd ?? process.cwd(),
            prompt: cmd.prompt ?? '',
            ...(cmd.resume_session_id ? { resume_session_id: cmd.resume_session_id } : {}),
            ...(cmd.model ? { model: cmd.model } : {}),
            ...(cmd.reasoning_effort ? { reasoning_effort: cmd.reasoning_effort } : {}),
          },
          controller.signal,
          defaultWriteFrame,
          process.env,
        ).finally(() => {
          rl.close();
        });
      }
    } catch {}
  });
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('stdio-runner.js') || process.argv[1].endsWith('stdio-runner.ts'));

if (isMainModule) {
  void runZeusStdioCli(process.argv.slice(2));
}
