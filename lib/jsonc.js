'use strict';

// MCP configs are often JSON with comments and trailing commas (VS Code, Cursor).
// Strings are copied through unchanged, so "//" and ",}" inside a string survive.

function parseJsonc(text) {
  let src = String(text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  try {
    return { data: JSON.parse(strip(src)), error: null };
  } catch (err) {
    return { data: null, error: err.message };
  }
}

function strip(input) {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < input.length) {
        if (input[i] === '\\') {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += input.slice(start, i);
      continue;
    }
    if (c === '/' && input[i + 1] === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i = Math.min(input.length, i + 2);
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return stripTrailingCommas(out);
}

function stripTrailingCommas(input) {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      const start = i;
      i += 1;
      while (i < input.length) {
        if (input[i] === '\\') {
          i += 2;
          continue;
        }
        if (input[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += input.slice(start, i);
      continue;
    }
    if (input[i] === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (input[j] === '}' || input[j] === ']') {
        i += 1;
        continue;
      }
    }
    out += input[i];
    i += 1;
  }
  return out;
}

module.exports = { parseJsonc };
