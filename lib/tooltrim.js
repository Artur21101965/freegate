// lib/tooltrim.js
// Trims oversized tool outputs in messages to prevent context bloat.
// Recent tool messages (model's current work) get a generous cap; older ones
// get stubbed (head+tail) since the model already processed them many turns ago.

const DEFAULT_OPTS = {
  enabled: true,
  oldMaxChars: 4000,        // ~1.1k tokens — stub level for old tool outputs
  recentMaxChars: 40000,    // ~11k tokens — generous for recent work
  keepRecent: 4,            // last N tool messages kept at recentMaxChars
};

/**
 * Trims oversized tool output messages (role:"tool") to prevent context bloat.
 * @param {Array} messages - OpenAI-format messages array
 * @param {Object} opts - { enabled, oldMaxChars, recentMaxChars, keepRecent }
 * @returns {{ messages: Array, trimmedCount: number, charsSaved: number }}
 */
function trimToolOutputs(messages, opts = {}) {
  const config = { ...DEFAULT_OPTS, ...opts };
  if (!config.enabled || !Array.isArray(messages) || messages.length === 0) {
    return { messages, trimmedCount: 0, charsSaved: 0 };
  }

  // Find all tool message indices (from the end, to identify "recent")
  const toolIndices = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === 'tool') toolIndices.push(i);
  }
  if (toolIndices.length === 0) {
    return { messages, trimmedCount: 0, charsSaved: 0 };
  }

  // Last keepRecent tool messages are "recent", rest are "old"
  const recentStartIdx = Math.max(0, toolIndices.length - config.keepRecent);
  const recentIndices = new Set(toolIndices.slice(recentStartIdx));

  let trimmedCount = 0;
  let charsSaved = 0;
  const result = messages.map((m, idx) => {
    if (!m || m.role !== 'tool') return m;
    const isRecent = recentIndices.has(idx);
    const maxChars = isRecent ? config.recentMaxChars : config.oldMaxChars;

    // Extract text content (string or array of text parts)
    let text = '';
    let isString = false;
    if (typeof m.content === 'string') {
      text = m.content;
      isString = true;
    } else if (Array.isArray(m.content)) {
      // Handle array of parts [{type:"text", text}, ...] — concatenate text parts
      const textParts = m.content.filter(c => c && c.type === 'text' && typeof c.text === 'string');
      if (textParts.length === 0) return m; // no text content, skip (e.g., images)
      text = textParts.map(c => c.text).join('');
      isString = false; // will rebuild array if trimmed
    } else {
      return m; // unknown content shape, skip
    }

    if (text.length <= maxChars) return m; // under cap, no trim needed

    // Trim: head + marker + tail
    const origLen = text.length;
    const half = Math.floor(maxChars / 2);
    const head = text.slice(0, half);
    const tail = text.slice(-half);
    const marker = `\n\n[... tool output truncated: ${origLen - maxChars} chars removed ...]\n\n`;
    const trimmed = head + marker + tail;

    trimmedCount++;
    charsSaved += origLen - trimmed.length;

    // Rebuild message with trimmed content. Fully-text arrays flatten to a
    // plain string (fewer surprises for strict providers); content stayed a
    // string, stays a string.
    if (isString) {
      return { ...m, content: trimmed };
    } else {
      return { ...m, content: trimmed };
    }
  });

  return { messages: result, trimmedCount, charsSaved };
}

module.exports = { trimToolOutputs, DEFAULT_OPTS };
