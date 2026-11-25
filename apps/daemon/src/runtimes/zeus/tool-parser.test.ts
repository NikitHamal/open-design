import assert from 'node:assert/strict';
import {
  StreamSplitter,
  canonicalizeToolArgs,
  extractToolCallsFromOutput,
  inferToolFromArgs,
  stripReasoningBlocks,
} from './tool-parser.js';

// 1. Direct <Write path="...">...</Write>
{
  const r = extractToolCallsFromOutput(
    '<Write path="landing.html">\n<!DOCTYPE html><html><body>Hello</body></html>\n</Write>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Write');
  assert.equal(r.toolCalls[0]!.arguments.file_path, 'landing.html');
}

// 2. Legacy <zeus_tool name="Write" path="...">
{
  const r = extractToolCallsFromOutput(
    '<zeus_tool name="Write" path="app.html"><!DOCTYPE html><html></html></zeus_tool>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Write');
  assert.equal(r.toolCalls[0]!.arguments.file_path, 'app.html');
}

// 3. Model uses "zeus_tool" as JSON tool name with Write arguments
{
  const r = extractToolCallsFromOutput(
    '<tool_call>{"name":"zeus_tool","arguments":{"path":"hero.html","content":"<!DOCTYPE html><html></html>"}}</tool_call>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Write');
  assert.equal(r.toolCalls[0]!.arguments.file_path, 'hero.html');
}

// 4. Model uses "zeus_tool" as JSON wrapper around inner tool name
{
  const r = extractToolCallsFromOutput(
    '<tool_call>{"name":"zeus_tool","arguments":{"name":"Bash","command":"ls -la"}}</tool_call>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Bash');
  assert.equal(r.toolCalls[0]!.arguments.command, 'ls -la');
}

// 5. Model emits <invoke name="zeus_tool"> with <parameter> tags
{
  const r = extractToolCallsFromOutput(
    '<function_calls><invoke name="zeus_tool"><parameter name="path">card.html</parameter><parameter name="content"><!DOCTYPE html><html></html></parameter></invoke></function_calls>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Write');
  assert.equal(r.toolCalls[0]!.arguments.file_path, 'card.html');
}

// 6. Empty/bogus <zeus_tool></zeus_tool> never produces a failed "zeus_tool" call
{
  const r = extractToolCallsFromOutput('<zeus_tool name="zeus_tool"></zeus_tool>');
  assert.equal(r.toolCalls.length, 0);
}

// 7. Nested <zeus_tool> inside <tool_call>
{
  const r = extractToolCallsFromOutput(
    '<tool_call>\n<zeus_tool name="Write" path="nested.html"><!DOCTYPE html><html></html></zeus_tool>\n</tool_call>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Write');
  assert.equal(r.toolCalls[0]!.arguments.file_path, 'nested.html');
}

// 8. Orphan closing </think> tag mentioning <zeus_tool> inside thought does not corrupt real call
{
  const r = extractToolCallsFromOutput(
    'I will use <zeus_tool> to create the page.</think>\n<Write path="clean.html"><!DOCTYPE html><html></html></Write>',
  );
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Write');
  assert.equal(r.toolCalls[0]!.arguments.file_path, 'clean.html');
}

// 9. StreamSplitter hides <Write> and <tool_call> and handles <thinking>
{
  let visible = '';
  let think = '';
  const sp = new StreamSplitter(
    (t) => {
      visible += t;
    },
    (th) => {
      think += th;
    },
  );
  sp.feed('<thinking>plan</thinking>Building.\n<Write path="a.html"><!DOCTYPE html></Write>\nDone.');
  sp.end();
  assert.equal(think, 'plan');
  assert.ok(!visible.includes('<Write'));
}

// 10. inferToolFromArgs & canonicalizeToolArgs
{
  const inferred = inferToolFromArgs({ path: 'test.html', content: '<h1>Hi</h1>' });
  assert.equal(inferred?.name, 'Write');
  const canon = canonicalizeToolArgs('Write', { path: 'test.html', html: '<h1>Hi</h1>' });
  assert.equal(canon.file_path, 'test.html');
  assert.equal(canon.content, '<h1>Hi</h1>');
}

// 11. stripReasoningBlocks handles <thought> and orphan </think>
{
  const s = stripReasoningBlocks('orphan thought</think><thought>second</thought>Visible answer');
  assert.equal(s.withoutThink, 'Visible answer');
  assert.ok(s.extractedThink.includes('orphan thought'));
  assert.ok(s.extractedThink.includes('second'));
}

console.log('[tool-parser.test] All assertions passed.');
