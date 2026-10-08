// RSSA canonical JSON: RFC 8785 (JCS) restricted to the RSSA signable subset.
//
// Signable values are strings, booleans, safe integers (|n| <= 2^53 - 1), null,
// arrays and objects of those. No floats, no exponents, no duplicate keys, no lone
// surrogates. Inside that subset JCS has exactly one correct output, so every
// language produces identical bytes — the restriction is what makes that true.

export class CanonicalError extends Error {
  code: string;
  path: string;
  constructor(code: string, message: string, path = "$") {
    super(`${message} (at ${path})`);
    this.code = code;
    this.path = path;
  }
}

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Strict JSON parser: rejects floats, exponents, unsafe integers, duplicate keys and lone surrogates. */
export function strictParse(text: string): Json {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const fail = (code: string, msg: string, path: string): never => {
    throw new CanonicalError(code, `${msg} at offset ${i}`, path);
  };
  const value = (path: string): Json => {
    ws();
    const c = text[i];
    if (c === "{") return object(path);
    if (c === "[") return array(path);
    if (c === '"') return string(path);
    if (c === "t" && text.startsWith("true", i)) { i += 4; return true; }
    if (c === "f" && text.startsWith("false", i)) { i += 5; return false; }
    if (c === "n" && text.startsWith("null", i)) { i += 4; return null; }
    if (c === "-" || (c >= "0" && c <= "9")) return number(path);
    return fail("syntax", `unexpected character ${JSON.stringify(c ?? "end of input")}`, path);
  };
  const number = (path: string): number => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m) return fail("syntax", "bad number", path);
    if (m[2] || m[3]) {
      fail("float", `number ${m[0]} is not an integer — send amounts and measurements as strings, e.g. "12.50"`, path);
    }
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail("unsafe-integer", `integer ${m[0]} is outside ±(2^53-1) — send it as a string`, path);
    i += m[0].length;
    return n;
  };
  const string = (path: string): string => {
    i++; // opening quote
    let out = "";
    while (true) {
      if (i >= text.length) fail("syntax", "unterminated string", path);
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c < " ") fail("syntax", "raw control character in string", path);
      if (c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (e in simple) { out += simple[e]; i += 2; continue; }
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("syntax", "bad \\u escape", path);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        fail("syntax", "bad escape", path);
      }
      out += c;
      i++;
    }
    assertWellFormed(out, path);
    return out;
  };
  const array = (path: string): Json[] => {
    i++;
    const out: Json[] = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    while (true) {
      out.push(value(`${path}[${out.length}]`));
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      fail("syntax", "expected , or ]", path);
    }
  };
  const object = (path: string): { [k: string]: Json } => {
    i++;
    const out: { [k: string]: Json } = {};
    ws();
    if (text[i] === "}") { i++; return out; }
    while (true) {
      ws();
      if (text[i] !== '"') fail("syntax", "expected a key", path);
      const k = string(path);
      if (Object.prototype.hasOwnProperty.call(out, k)) fail("duplicate-key", `duplicate key ${JSON.stringify(k)}`, path);
      ws();
      if (text[i] !== ":") fail("syntax", "expected :", path);
      i++;
      out[k] = value(`${path}.${k}`);
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail("syntax", "expected , or }", path);
    }
  };
  const v = value("$");
  ws();
  if (i !== text.length) fail("syntax", "trailing characters after JSON value", "$");
  return v;
}

function assertWellFormed(s: string, path: string) {
  for (let j = 0; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(j + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new CanonicalError("lone-surrogate", "string contains a lone surrogate", path);
      j++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalError("lone-surrogate", "string contains a lone surrogate", path);
    }
  }
}

function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// JCS sorts keys by UTF-16 code units, which is plain JS string comparison.
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical JSON text of a value in the RSSA signable subset. Throws CanonicalError otherwise. */
export function canonicalize(v: unknown, path = "$"): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") { assertWellFormed(v, path); return quote(v); }
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new CanonicalError("float", `number ${v} is not an integer — send it as a string`, path);
    if (Math.abs(v) > MAX_SAFE) throw new CanonicalError("unsafe-integer", `integer ${v} is outside ±(2^53-1)`, path);
    return Object.is(v, -0) ? "0" : String(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x, n) => canonicalize(x, `${path}[${n}]`)).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v as object).sort(byCodeUnits);
    return "{" + keys.map((k) => { assertWellFormed(k, path); return quote(k) + ":" + canonicalize((v as any)[k], `${path}.${k}`); }).join(",") + "}";
  }
  throw new CanonicalError("type", `type ${typeof v} cannot be signed`, path);
}

export const utf8 = (s: string) => new TextEncoder().encode(s);
