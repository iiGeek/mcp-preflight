'use strict';

// Reader for the Codex `mcp_servers` subset. Other tables are skipped, including
// multiline strings, so a normal Codex config.toml still yields its MCP servers.
// Inside an mcp_servers table the supported values are strings, booleans,
// numbers, arrays, and inline tables of those.

function parseMcpServers(text) {
  const src = String(text).charCodeAt(0) === 0xfeff ? String(text).slice(1) : String(text);
  const parser = new Parser(src);
  return parser.parse();
}

class Parser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
    this.servers = {};
    this.errors = [];
    this.table = null;
  }

  parse() {
    while (this.skipWsAndComments()) {
      try {
        if (this.peek() === '[') {
          this.readTable();
          continue;
        }
        if (!this.table) {
          this.readKeyAndEquals();
          this.skipWsAndComments();
          this.readValue();
          continue;
        }
        const key = this.readKeyAndEquals();
        this.skipWsAndComments();
        const value = this.readValue();
        this.assign(key, value);
      } catch (err) {
        // Keep servers that parsed. A later table may still be readable.
        if (this.table) this.errors.push(err.message || String(err));
        this.skipToLine();
      }
    }
    return { servers: this.servers, errors: this.errors };
  }

  skipToLine() {
    while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
    if (this.pos < this.text.length) this.pos += 1;
  }

  peek() {
    return this.text[this.pos];
  }

  skipWsAndComments() {
    const text = this.text;
    while (this.pos < text.length) {
      const c = text[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.pos += 1;
        continue;
      }
      if (c === '#') {
        while (this.pos < text.length && text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return true;
    }
    return false;
  }

  readTable() {
    const start = this.pos;
    if (this.text[this.pos + 1] === '[') {
      const start = this.pos;
      this.pos += 2;
      while (this.pos < this.text.length && !(this.text[this.pos] === ']' && this.text[this.pos + 1] === ']')) {
        this.pos += 1;
      }
      const header = this.text.slice(start + 2, this.pos).trim();
      this.pos = Math.min(this.text.length, this.pos + 2);
      this.table = null;
      if (header === 'mcp_servers' || header.startsWith('mcp_servers.') || header.startsWith('mcp_servers"')) {
        this.errors.push('Array-of-tables syntax is not supported for mcp_servers');
      }
      return;
    }
    this.pos += 1;
    const raw = this.readUntil(']');
    if (this.peek() !== ']') throw new Error(`Unclosed table header near ${snippet(this.text, start)}`);
    this.pos += 1;
    const parts = splitDotted(raw);
    if (parts[0] === 'mcp_servers') this.table = parts.slice(1);
    else this.table = null;
  }

  readKeyAndEquals() {
    this.skipWsAndComments();
    const start = this.pos;
    let quote = null;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (quote) {
        if (c === '\\' && quote === '"') {
          this.pos += 2;
          continue;
        }
        if (c === quote) quote = null;
        this.pos += 1;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        this.pos += 1;
        continue;
      }
      if (c === '=') break;
      if (c === '\n' || c === '[') break;
      this.pos += 1;
    }
    const raw = this.text.slice(start, this.pos).trim();
    if (this.peek() !== '=') {
      throw new Error(`Expected '=' after "${raw || snippet(this.text, start)}"`);
    }
    this.pos += 1;
    if (!raw) throw new Error('Missing key before "="');
    return raw;
  }

  readValue() {
    this.skipWsAndComments();
    const c = this.peek();
    if (c === '"') return this.readQuoted('"');
    if (c === "'") return this.readQuoted("'");
    if (c === '[') return this.readArray();
    if (c === '{') return this.readInline();
    const start = this.pos;
    while (this.pos < this.text.length && !/[\s,#\]}]/.test(this.text[this.pos])) this.pos += 1;
    const raw = this.text.slice(start, this.pos);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return raw;
    if (!raw) throw new Error(`Missing value near ${snippet(this.text, start)}`);
    throw new Error(`Unsupported TOML value "${raw}"`);
  }

  readQuoted(quote) {
    const triple = this.text.startsWith(quote.repeat(3), this.pos);
    if (triple) {
      this.pos += 3;
      if (this.text[this.pos] === '\r' && this.text[this.pos + 1] === '\n') this.pos += 2;
      else if (this.text[this.pos] === '\n') this.pos += 1;
      let out = '';
      const end = quote.repeat(3);
      while (this.pos < this.text.length && !this.text.startsWith(end, this.pos)) {
        if (quote === '"' && this.text[this.pos] === '\\') {
          out += decodeEscape(this.text[this.pos + 1]);
          this.pos += 2;
          continue;
        }
        out += this.text[this.pos];
        this.pos += 1;
      }
      if (!this.text.startsWith(end, this.pos)) throw new Error('Unclosed multiline string');
      this.pos += 3;
      return out;
    }
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length && this.text[this.pos] !== quote) {
      if (this.text[this.pos] === '\n') throw new Error('Unclosed string');
      if (quote === '"' && this.text[this.pos] === '\\') {
        out += decodeEscape(this.text[this.pos + 1]);
        this.pos += 2;
        continue;
      }
      out += this.text[this.pos];
      this.pos += 1;
    }
    if (this.text[this.pos] !== quote) throw new Error('Unclosed string');
    this.pos += 1;
    return out;
  }

  readArray() {
    this.pos += 1;
    const arr = [];
    while (this.skipWsAndComments()) {
      if (this.peek() === ']') {
        this.pos += 1;
        return arr;
      }
      arr.push(this.readValue());
      this.skipWsAndComments();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === ']') {
        this.pos += 1;
        return arr;
      }
      throw new Error('Expected "," or "]" in array');
    }
    throw new Error('Unclosed array');
  }

  readInline() {
    this.pos += 1;
    const obj = {};
    while (this.skipWsAndComments()) {
      if (this.peek() === '}') {
        this.pos += 1;
        return obj;
      }
      const key = this.readKeyAndEquals();
      this.skipWsAndComments();
      const parts = splitDotted(key);
      assignPath(obj, parts, this.readValue());
      this.skipWsAndComments();
      if (this.peek() === ',') {
        this.pos += 1;
        continue;
      }
      if (this.peek() === '}') {
        this.pos += 1;
        return obj;
      }
      throw new Error('Expected "," or "}" in inline table');
    }
    throw new Error('Unclosed inline table');
  }

  readUntil(endChar) {
    const start = this.pos;
    let quote = null;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (quote) {
        if (c === '\\' && quote === '"') {
          this.pos += 2;
          continue;
        }
        if (c === quote) quote = null;
        this.pos += 1;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        this.pos += 1;
        continue;
      }
      if (c === endChar) break;
      this.pos += 1;
    }
    return this.text.slice(start, this.pos);
  }

  assign(key, value) {
    if (!this.table || !this.table.length) {
      this.errors.push('mcp_servers entry is missing a server name');
      return;
    }
    const name = this.table[0];
    if (!this.servers[name]) this.servers[name] = {};
    const parts = this.table.slice(1).concat(splitDotted(key));
    assignPath(this.servers[name], parts, value);
  }
}

function assignPath(root, parts, value) {
  let obj = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!obj[p] || typeof obj[p] !== 'object' || Array.isArray(obj[p])) obj[p] = {};
    obj = obj[p];
  }
  const last = parts[parts.length - 1];
  if (
    (last === 'env' || last === 'http_headers' || last === 'env_http_headers') &&
    isPlain(value) &&
    isPlain(obj[last])
  ) {
    Object.assign(obj[last], value);
    return;
  }
  obj[last] = value;
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function splitDotted(raw) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += raw[i + 1] || '';
        i += 1;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '.') {
      if (cur) parts.push(cur);
      cur = '';
      continue;
    }
    if (/\s/.test(c)) continue;
    cur += c;
  }
  if (cur) parts.push(cur);
  return parts;
}

function decodeEscape(c) {
  const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', b: '\b', f: '\f', "'": "'" };
  return map[c] ?? c ?? '';
}

function snippet(text, index) {
  return text.slice(index, index + 40).replace(/\s+/g, ' ').trim() || 'end of file';
}

module.exports = { parseMcpServers };
