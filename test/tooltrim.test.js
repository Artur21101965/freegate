// test/tooltrim.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { trimToolOutputs } = require('../lib/tooltrim');

describe('trimToolOutputs', () => {
  it('leaves short tool outputs unchanged', () => {
    const messages = [
      { role: 'user', content: 'run ls' },
      { role: 'assistant', content: 'running ls', tool_calls: [{ id: 't1', function: { name: 'bash' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'bash', content: 'file1.txt\nfile2.txt' },
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 4 });
    assert.strictEqual(result.trimmedCount, 0);
    assert.strictEqual(result.charsSaved, 0);
    assert.deepStrictEqual(result.messages, messages);
  });

  it('trims giant OLD tool output (head+tail with marker)', () => {
    const giant = 'A'.repeat(10000);
    const messages = [
      { role: 'tool', tool_call_id: 't1', name: 'bash', content: giant },
      { role: 'tool', tool_call_id: 't2', name: 'bash', content: 'short' }, // recent
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 1 });
    assert.strictEqual(result.trimmedCount, 1);
    assert.ok(result.charsSaved > 5000);
    const trimmed = result.messages[0].content;
    assert.ok(trimmed.includes('[... tool output truncated:'));
    assert.ok(trimmed.length < 5000); // head+tail+marker < cap
    assert.ok(trimmed.startsWith('AAA')); // head present
    assert.ok(trimmed.endsWith('AAA')); // tail present
    // recent unchanged
    assert.strictEqual(result.messages[1].content, 'short');
  });

  it('keeps last keepRecent tool messages fully intact (even if giant)', () => {
    const giant = 'B'.repeat(50000);
    const messages = [
      { role: 'tool', tool_call_id: 't1', content: 'B'.repeat(10000) }, // old
      { role: 'tool', tool_call_id: 't2', content: giant }, // recent (within keepRecent=2)
      { role: 'tool', tool_call_id: 't3', content: giant }, // recent
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 2 });
    // Old one trimmed
    assert.ok(result.messages[0].content.length < 5000);
    assert.ok(result.messages[0].content.includes('truncated'));
    // Recent two: capped at recentMaxChars (40000)
    assert.ok(result.messages[1].content.length <= 41000); // approx cap + marker
    assert.ok(result.messages[2].content.length <= 41000);
    assert.ok(result.trimmedCount >= 1); // at least the old one
  });

  it('does not trim non-tool messages', () => {
    const giant = 'X'.repeat(100000);
    const messages = [
      { role: 'user', content: giant },
      { role: 'assistant', content: giant },
      { role: 'system', content: giant },
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 4 });
    assert.strictEqual(result.trimmedCount, 0);
    assert.strictEqual(result.charsSaved, 0);
    assert.strictEqual(result.messages[0].content.length, 100000);
  });

  it('handles array content with text parts', () => {
    const giant = 'T'.repeat(10000);
    const messages = [
      { role: 'tool', tool_call_id: 't1', content: [{ type: 'text', text: giant }] },
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 0 });
    assert.strictEqual(result.trimmedCount, 1);
    const trimmed = result.messages[0].content;
    // should have been flattened to string and trimmed
    assert.strictEqual(typeof trimmed, 'string');
    assert.ok(trimmed.includes('truncated'));
    assert.ok(trimmed.length < 5000);
  });

  it('leaves array content with non-text parts (images) untouched', () => {
    const messages = [
      { role: 'tool', tool_call_id: 't1', content: [{ type: 'image_url', image_url: { url: 'http://...' } }] },
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 4 });
    assert.strictEqual(result.trimmedCount, 0);
    assert.deepStrictEqual(result.messages[0].content, messages[0].content);
  });

  it('returns empty arrays when disabled', () => {
    const giant = 'Z'.repeat(100000);
    const messages = [{ role: 'tool', tool_call_id: 't1', content: giant }];
    const result = trimToolOutputs(messages, { enabled: false, oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 4 });
    assert.strictEqual(result.trimmedCount, 0);
    assert.strictEqual(result.charsSaved, 0);
    assert.deepStrictEqual(result.messages, messages);
  });

  it('counts from the END for keepRecent (last N tool messages)', () => {
    const messages = [
      { role: 'tool', tool_call_id: 't1', content: 'A'.repeat(10000) }, // old (index 0)
      { role: 'user', content: 'foo' },
      { role: 'tool', tool_call_id: 't2', content: 'B'.repeat(10000) }, // old (index 2)
      { role: 'assistant', content: 'bar' },
      { role: 'tool', tool_call_id: 't3', content: 'C'.repeat(10000) }, // recent (last tool, within keepRecent=1)
    ];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 1 });
    // First two tool messages (t1, t2) should be trimmed; last one (t3) intact
    assert.ok(result.messages[0].content.includes('truncated'));
    assert.ok(result.messages[2].content.includes('truncated'));
    assert.strictEqual(result.messages[4].content, 'C'.repeat(10000)); // recent untouched
    assert.strictEqual(result.trimmedCount, 2);
  });

  it('computes charsSaved correctly', () => {
    const giant = 'D'.repeat(20000);
    const messages = [{ role: 'tool', tool_call_id: 't1', content: giant }];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 0 });
    const trimmedLen = result.messages[0].content.length;
    assert.strictEqual(result.charsSaved, 20000 - trimmedLen);
    assert.ok(result.charsSaved > 15000);
  });

  it('preserves tool_call_id and name fields', () => {
    const messages = [{ role: 'tool', tool_call_id: 'call_abc', name: 'bash', content: 'E'.repeat(10000) }];
    const result = trimToolOutputs(messages, { oldMaxChars: 4000, recentMaxChars: 40000, keepRecent: 0 });
    assert.strictEqual(result.messages[0].tool_call_id, 'call_abc');
    assert.strictEqual(result.messages[0].name, 'bash');
    assert.strictEqual(result.messages[0].role, 'tool');
  });
});
