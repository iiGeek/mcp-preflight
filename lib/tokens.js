'use strict';

// Rough stand-in for the tokens a tool schema will cost in a prompt.
// It is character length divided by 4, rounded up. It is not a model tokenizer
// and will not match a specific provider's count.
function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

module.exports = { estimateTokens };
