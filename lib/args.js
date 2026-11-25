'use strict';

// Split a command string the way a careful config author would expect:
// whitespace separates arguments, quotes group them, backslash escapes.
function splitArgs(input) {
  return splitDetailed(input).map((part) => part.text);
}

// quote is "'", '"', or null. A word that mixes quotes reports the first quote
// that wrapped any of it; unquoted words stay null.
function splitDetailed(input) {
  const args = [];
  let cur = '';
  let quote = null;
  let wordQuote = null;
  const s = String(input);
  const push = () => {
    if (!cur && !wordQuote) return;
    args.push({ text: cur, quote: wordQuote });
    cur = '';
    wordQuote = null;
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      wordQuote = wordQuote || c;
      continue;
    }
    if (c === '\\') {
      cur += s[i + 1] || '';
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return args;
}

module.exports = { splitArgs, splitDetailed };
