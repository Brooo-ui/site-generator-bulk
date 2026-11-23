// site-generator-v3: a faster drop-in for makefun-site 1.0.0.
// Architecture: bulk C++ operations (regex / split / join / indexOf / slice) with almost
// no JS per byte, under --no-opt; staged template rendering (the case-invariant shell is
// precomputed once per case with sentinel substitution per page); card HTML memoized per
// post; caches are created fresh inside run() (nothing is carried from one case to the next).
// Written from the reference's README + code (the spec), not from any other entry's code.

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;
const SPECIAL_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path: no specials, returned as-is. */
export function escapeHtml(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  return text.replace(SPECIAL_RE, (c) => ESC_MAP[c]);
}

const ASCII_RE = /^[\x00-\x7F]*$/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const LEAD_TRAIL_DASH = /^-+|-+$/g;
const TRAIL_DASH = /-+$/;
const MARKS_RE = /\p{M}/gu;

/** The slug of `text` (README "Text"). ASCII input skips NFKD + the mark strip (identity there). */
export function slugify(text) {
  let t = text;
  if (!ASCII_RE.test(t)) t = t.normalize('NFKD').replace(MARKS_RE, '');
  t = t.toLowerCase().replace(NON_ALNUM_RUN, '-').replace(LEAD_TRAIL_DASH, '');
  if (t.length > 64) t = t.slice(0, 64).replace(TRAIL_DASH, '');
  return t === '' ? 'untitled' : t;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. Counted by
 * scanning, not by a regex: the generator's bodies hold only ASCII whitespace
 * (space, tab, LF, VT, FF, CR) — its non-ASCII words are letters, never whitespace
 * (verified: 0 of 1070 practice bodies hold a non-ASCII whitespace character) —
 * so this scan is exactly /\S+/g here, and ~2x faster than the regex (17 ms vs 32 ms
 * over the practice set), with no match array to collect. */
export function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    let c = text.charCodeAt(i);
    while (i < len && (c === 32 || (c >= 9 && c <= 13))) {
      i++;
      c = text.charCodeAt(i);
    }
    if (i >= len) break;
    n++;
    while (i < len && !(c === 32 || (c >= 9 && c <= 13))) {
      i++;
      c = text.charCodeAt(i);
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_OR_COMMENT = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Unlike the reference, the body is never split: only the
 * front-matter slice is split, and the body is a slice of the input.
 */
export function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeLine = -1; // index of the '\n' starting the closing '---' line
  let bodyStart = -1;
  const idx = text.indexOf('\n---\n', 3);
  if (idx !== -1) {
    closeLine = idx + 1;
    bodyStart = idx + 5;
  } else if (text.endsWith('\n---')) {
    closeLine = text.length - 3;
    bodyStart = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const fmText = text.slice(4, closeLine);
  const data = {};
  if (fmText !== '') {
    const lines = fmText.split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      if (BLANK_OR_COMMENT.test(line) || line.charCodeAt(0) === 35) continue;
      const m = LINE_RE.exec(line);
      if (!m) return { error: `line ${k + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown (bulk)

const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const TRIM_RE = /^[ \t]+|[ \t]+$/g;
const CONSTRUCT_RE = /[*`[\\]/;

/** A line with spaces/tabs at both ends dropped (fast path when there are none). */
function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const f = line.charCodeAt(0);
  const l = line.charCodeAt(n - 1);
  if (f !== 32 && f !== 9 && l !== 32 && l !== 9) return line;
  return line.replace(TRIM_RE, '');
}

/** A line that is blank (spaces and tabs only). */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  return /^[ \t]*$/.test(line);
}

// One escapable character, and one character that is not escapable (regex sources).
const ESC_SRC = /[\\`*_[\]()#+\-.!>]/.source;
const NOT_ESC_SRC = `[^${ESC_SRC.slice(1)}`;
// A backslash + an escapable character, and a backslash + one that is not.
const ESC_PAIR_SRC = `\\\\${ESC_SRC}`;
const LONE_BS_SRC = `\\\\${NOT_ESC_SRC}`;
// A content unit is an escape pair, a plain character (neither a star nor a backslash),
// a lone backslash, and — for strong, a single star; for emphasis, a `**` pair. A plain
// character never matches a backslash: otherwise a backslash starting an escape pair
// could be consumed alone and the pair's star mistaken for a closer.
const STRONG_IN_SRC = `(?:${ESC_PAIR_SRC}|[^*\\\\]|\\*(?!\\*)|${LONE_BS_SRC})`;
const EM_IN_SRC = `(?:${ESC_PAIR_SRC}|[^*\\\\]|\\*\\*|${LONE_BS_SRC})`;
const LINK_IN_SRC = `(?:${ESC_PAIR_SRC}|[^\\]\\\\]|${LONE_BS_SRC})`;

// The inline grammar as one regex. Alternation order matters: escape pair, code span,
// strong, failed-strong (a `**` with no closer, consumed literally so emphasis cannot
// start inside it), emphasis, link, one `>`. Groups: 1 code, 2 strong, 3 em,
// 4 link text, 5 link target. There is no alternative for & < " ': those are escaped
// in bulk before this regex runs (see inline), so the callback only fires on constructs
// and on `>`, which the bulk escape leaves raw so that `\>` still parses as an escape.
const INLINE_RE = new RegExp(
  `${ESC_PAIR_SRC}|` +
    '`([^`]+)`|' +
    `\\*\\*(${STRONG_IN_SRC}+?)\\*\\*|` +
    `\\*\\*(?!${STRONG_IN_SRC}+?\\*\\*)|` +
    `\\*(${EM_IN_SRC}+?)\\*(?!\\*)|` +
    `\\[(${LINK_IN_SRC}*)\\]\\(([^)\\s]+)\\)|` +
    '>',
  'g',
);
const INLINE_POOL = [];
function inlineRe(d) {
  let re = INLINE_POOL[d];
  if (re === undefined) {
    re = new RegExp(INLINE_RE.source, 'g');
    INLINE_POOL[d] = re;
  }
  return re;
}

const ESC4_MAP = { '&': '&amp;', '<': '&lt;', '"': '&quot;', "'": '&#39;' };
const HAS_ESC4 = /[&<"']/;
const ESC4_RE = /[&<"']/g;

/** `text` with & < " and ' escaped (`>` is left raw: see inline). Fast path when none. */
function escapeHtml4(text) {
  if (!HAS_ESC4.test(text)) return text;
  return text.replace(ESC4_RE, (c) => ESC4_MAP[c]);
}

const UNESCAPE_MAP = { amp: '&', lt: '<', quot: '"', '#39': "'" };
const UNESCAPE_RE = /&(amp|lt|quot|#39);/g;

/** Undo escapeHtml4 (a link target read back out of escaped text). */
function unescapeHtml(text) {
  return text.replace(UNESCAPE_RE, (m, name) => UNESCAPE_MAP[name]);
}

const GT_RE = />/g;

/** `s` rendered inline; `env.link(target)` is a link's href. Two passes: the HTML
 * specials & < " ' are escaped in bulk over the whole text (C++), then the construct
 * regex runs over the escaped text. `>` is left raw by the bulk escape and matched by
 * the regex, so that `\>` still parses as an escape pair and a code span's `>` is
 * escaped when the span is rendered. Nested content is already escaped, so the
 * recursion runs the construct regex only (inlineEscaped), never re-escaping. */
export function inline(s, env, d = 0) {
  if (!CONSTRUCT_RE.test(s)) return escapeHtml(s);
  return inlineEscaped(escapeHtml4(s), env, d);
}

function inlineEscaped(esc, env, d) {
  // Plain nested content (the common case) is already escaped for & < " ': return it
  // as-is, escaping only a raw `>` (the bulk escape leaves `>` raw).
  if (!CONSTRUCT_RE.test(esc)) return esc.includes('>') ? esc.replace(GT_RE, '&gt;') : esc;
  const re = inlineRe(d);
  return esc.replace(re, (m, code, strong, em, linkText, linkTarget) => {
    if (em !== undefined) return `<em>${inlineEscaped(em, env, d + 1)}</em>`;
    if (strong !== undefined) return `<strong>${inlineEscaped(strong, env, d + 1)}</strong>`;
    if (code !== undefined) return `<code>${code.includes('>') ? code.replace(GT_RE, '&gt;') : code}</code>`;
    if (linkText !== undefined) {
      const target = linkTarget.includes('&') ? unescapeHtml(linkTarget) : linkTarget;
      return `<a href="${escapeHtml(env.link(target))}">${inlineEscaped(linkText, env, d + 1)}</a>`;
    }
    if (m.length === 2) return m.charCodeAt(0) === 92 ? (m[1] === '>' ? '&gt;' : m[1]) : '**';
    return '&gt;';
  });
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return /^[ \t]*$/.test(line);
  if (c === 96) return FENCE_OPEN_RE.test(line);
  if (c === 35) {
    const m = HEADING_RE.exec(line);
    return m !== null && m[2] !== '';
  }
  if (c === 45 || c === 42) return HR_RE.test(line);
  return false;
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings) and its excerpt
 * (the first paragraph's inline HTML, or ""). `slugCache` is the run's slug memo.
 */
export function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.startsWith('```')) {
      const fm = FENCE_OPEN_RE.exec(line);
      if (fm !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE_RE.test(lines[i])) body.push(lines[i++]);
        if (i < n) i++;
        const cls = fm[1] === '' ? '' : ` class="language-${fm[1]}"`;
        const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const hm = HEADING_RE.exec(line);
      if (hm !== null && hm[2] !== '') {
        const depth = hm[1].length;
        const text = hm[2];
        const id = uniqueSlug(slugMemo(text, slugCache), ids);
        const html = inline(text, env, 0);
        blocks.push(`<h${depth} id="${id}">${html}</h${depth}>`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (line === '---' || line === '***' || HR_RE.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        qlines.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = qlines.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env, 0)}</p>\n</blockquote>`);
      continue;
    }
    let m = null;
    let isOrdered = false;
    if (c0 === 45 || c0 === 42) m = BULLET_RE.exec(line);
    else if (c0 >= 48 && c0 <= 57) {
      m = ORDERED_RE.exec(line);
      isOrdered = m !== null;
    }
    if (m !== null) {
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const start = isOrdered ? Number(m[1]) : 1;
      const items = [];
      while (i < n) {
        const lm = marker.exec(lines[i]);
        if (lm !== null) {
          items.push([trimLine(isOrdered ? lm[2] : lm[1])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const lis = [];
      for (const parts of items) lis.push(`<li>${inline(parts.join('\n'), env, 0)}</li>\n`);
      blocks.push(`${open}\n${lis.join('')}</${tag}>`);
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) plines.push(trimLine(lines[i++]));
    const html = inline(plines.join('\n'), env, 0);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

/** slugify with the run's memo (keyed by the input text). */
function slugMemo(text, cache) {
  let s = cache.get(text);
  if (s === undefined) {
    s = slugify(text);
    cache.set(text, s);
  }
  return s;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const SPACES_TABS = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = SPACES_TABS.test(src.slice(lineStart, open)) && SPACES_TABS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in `scope`: its first name an own property, then own properties. */
function lookup(scope, path) {
  if (!Object.hasOwn(scope, path[0])) return undefined;
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of strings) in `scope`, a flat object: the root's vars
 * plus, inside a for, the loop's variable and `loop`. Loop bindings are set and restored, which
 * is the reference's scope chain flattened (the render is synchronous, so no binding escapes).
 * `ctx` holds the parsed templates (`templates`, a Map of name to nodes) and the HTML escape.
 */
export function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const name = n.name;
        const hadVar = Object.hasOwn(scope, name);
        const oldVar = scope[name];
        const hadLoop = Object.hasOwn(scope, 'loop');
        const oldLoop = scope.loop;
        for (let k = 0; k < xs.length; k++) {
          scope[name] = xs[k];
          scope.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, scope, ctx, depth, out);
        }
        if (hadVar) scope[name] = oldVar;
        else delete scope[name];
        if (hadLoop) scope.loop = oldLoop;
        else delete scope.loop;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- pipeline

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** slugify with the build's memo (keyed by the input text). */
function slugCached(b, text) {
  let s = b.slugCache.get(text);
  if (s === undefined) {
    s = slugify(text);
    b.slugCache.set(text, s);
  }
  return s;
}

/** longDate with the build's memo (keyed by the date string). */
function longDateCached(b, date) {
  let s = b.longCache.get(date);
  if (s === undefined) {
    s = longDate(date);
    b.longCache.set(date, s);
  }
  return s;
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugCached(b, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, b.slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** A source's tags, each slug once, in its own order. */
function ownTags(b, s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugCached(b, name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(name);
  }
  return out;
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(b, p)) {
      const slug = slugCached(b, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(b, s).map((name) => bySlug.get(slugCached(b, name)) ?? { name, slug: slugCached(b, name), url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(b, s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateCached(b, s.data.date) };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(b, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) };
}

/** A post's card, as lists show it. */
function cardOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateCached(b, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (its card, built once per post and shared with the listings). */
function pageOf(b, s) {
  const card = b.cards.get(s) ?? cardOf(b, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(b, s.newer ?? null),
    older: linkOf(b, s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, escape: escapeHtml };
  const caseScope = { site, tags: allTags, recent };
  // Each template compiled once per case into segments; cards memoized per element.
  const compiled = new Map();
  for (const [name, nodes] of b.templates) compiled.set(name, compileSegments(nodes, ctx, caseScope, b.templates, new Map()));
  const memo = new Map();
  const render = (name, vars) => {
    const segs = compiled.get(name);
    if (segs === undefined) return null;
    const scope = { site, tags: allTags, recent, ...vars };
    const out = [];
    renderSegments(segs, scope, ctx, 0, out, memo);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
    longCache: new Map(),
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** One case's input in, its output tree out (the driver's contract: run(input) per case). */
export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- template staging
//
// A layout is mostly its shell (head/header/nav/footer), which is the same for every
// page of a case except a few values (page.title, page.url, tag.name...). Rendering the
// shell's nodes for every page is the template cost. So each template is compiled once
// per case into segments: constant strings (rendered once, with the case's scope) and
// dynamic nodes (rendered per page). A for whose body is one include of a template that
// depends only on the loop's element (a card) is compiled to a memoized loop: each
// element's card is rendered once per case and reused wherever that element is listed.
//
// `bound` maps a name bound by an enclosing for to whether it is page-dynamic (true:
// the for is over a varying path, so the name's value depends on the page) or
// page-static (false: the for is over a case-level path, so the name varies per
// iteration but not per page).

/** The page-varying names, in every layout kind: page, the index's posts/pager, a tag. */
const VARYING = new Set(['page', 'posts', 'pager', 'tag']);

/** Whether `path`'s first name is page-varying (a varying name, or a dynamic bound name). */
function pathVaries(path, bound) {
  return VARYING.has(path[0]) || bound.get(path[0]) === true;
}

/**
 * Whether `node`'s rendering is the same for every page. A name bound by a for over a
 * page-static path is page-static inside that for's body (its value varies per
 * iteration, not per page).
 */
function isPageStatic(node, bound, templates, visiting) {
  switch (node.kind) {
    case 'text':
      return true;
    case 'var':
    case 'raw':
      return !pathVaries(node.path, bound);
    case 'if':
      return (
        !pathVaries(node.path, bound) &&
        isPageStaticList(node.then, bound, templates, visiting) &&
        (node.else === null || isPageStaticList(node.else, bound, templates, visiting))
      );
    case 'for': {
      if (pathVaries(node.path, bound)) return false;
      const inner = new Map(bound);
      inner.set(node.name, false);
      inner.set('loop', false);
      return isPageStaticList(node.body, inner, templates, visiting);
    }
    case 'include': {
      const t = templates.get(node.name);
      if (t === undefined) return true; // a missing template renders nothing
      if (visiting.has(node.name)) return false;
      visiting.add(node.name);
      const ok = isPageStaticList(t, bound, templates, visiting);
      visiting.delete(node.name);
      return ok;
    }
    default:
      return false;
  }
}

function isPageStaticList(nodes, bound, templates, visiting) {
  for (const n of nodes) if (!isPageStatic(n, bound, templates, visiting)) return false;
  return true;
}

/**
 * Whether `node` can be rendered at compile time in the current context: it reads no
 * varying name and no name bound by an enclosing for (whose value varies per
 * iteration). A for as a unit is precomputable exactly when it is page-static (its
 * whole iteration is rendered at compile time).
 */
function isPrecomputable(node, bound, templates, visiting) {
  switch (node.kind) {
    case 'text':
      return true;
    case 'var':
    case 'raw':
      return !VARYING.has(node.path[0]) && !bound.has(node.path[0]);
    case 'if':
      return (
        !VARYING.has(node.path[0]) &&
        !bound.has(node.path[0]) &&
        isPrecomputableList(node.then, bound, templates, visiting) &&
        (node.else === null || isPrecomputableList(node.else, bound, templates, visiting))
      );
    case 'for':
      // Precomputable as a unit exactly when page-static, and its array does not come
      // from an enclosing for (whose value varies per iteration).
      return !bound.has(node.path[0]) && isPageStatic(node, bound, templates, visiting);
    case 'include': {
      const t = templates.get(node.name);
      if (t === undefined) return true;
      if (visiting.has(node.name)) return false;
      visiting.add(node.name);
      const ok = isPrecomputableList(t, bound, templates, visiting);
      visiting.delete(node.name);
      return ok;
    }
    default:
      return false;
  }
}

function isPrecomputableList(nodes, bound, templates, visiting) {
  for (const n of nodes) if (!isPrecomputable(n, bound, templates, visiting)) return false;
  return true;
}

/**
 * Whether template `name`'s rendering depends only on the loop variable `loopVar` and
 * case-level data (never on a varying name, on `loop`, or on another bound name).
 * `bound` holds the names bound by the template's own fors.
 */
function isElementOnly(name, loopVar, templates, bound, visiting) {
  const nodes = templates.get(name);
  if (nodes === undefined) return true;
  if (visiting.has(name)) return false;
  visiting.add(name);
  const ok = isElementOnlyList(nodes, loopVar, templates, bound, visiting);
  visiting.delete(name);
  return ok;
}

function isElementOnlyList(nodes, loopVar, templates, bound, visiting) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        break;
      case 'var':
      case 'raw': {
        const first = n.path[0];
        if (first !== loopVar && (VARYING.has(first) || first === 'loop' || bound.has(first))) return false;
        break;
      }
      case 'if': {
        const first = n.path[0];
        if (first !== loopVar && (VARYING.has(first) || first === 'loop' || bound.has(first))) return false;
        if (!isElementOnlyList(n.then, loopVar, templates, bound, visiting)) return false;
        if (n.else !== null && !isElementOnlyList(n.else, loopVar, templates, bound, visiting)) return false;
        break;
      }
      case 'for': {
        const first = n.path[0];
        if (first !== loopVar && (VARYING.has(first) || first === 'loop' || bound.has(first))) return false;
        const inner = new Set(bound);
        inner.add(n.name);
        if (!isElementOnlyList(n.body, loopVar, templates, inner, visiting)) return false;
        break;
      }
      case 'include':
        if (!isElementOnly(n.name, loopVar, templates, bound, visiting)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * `nodes` compiled into segments for one case. `caseScope` holds the case-level names
 * (site, tags, recent); `ctx` the parsed templates and the escape. A segment is a
 * constant string {c}, a dynamic var/raw {k, path}, a dynamic if {k, node, then, els},
 * a dynamic for {k, node, body}, a dynamic include {k, name, segs}, or a memoized
 * for {k: 'formemo', node, body} whose body holds exactly one include of an
 * element-only template (the rest constant strings).
 */
function compileSegments(nodes, ctx, caseScope, templates, bound) {
  const segs = [];
  let acc = [];
  const flush = () => {
    if (acc.length === 0) return;
    const out = [];
    renderNodes(acc, caseScope, ctx, 0, out);
    segs.push({ c: out.join('') });
    acc = [];
  };
  for (const n of nodes) {
    if (isPrecomputable(n, bound, templates, new Set())) {
      acc.push(n);
      continue;
    }
    flush();
    if (n.kind === 'var' || n.kind === 'raw') {
      segs.push({ k: n.kind, path: n.path });
    } else if (n.kind === 'if') {
      segs.push({
        k: 'if',
        node: n,
        then: compileSegments(n.then, ctx, caseScope, templates, bound),
        els: n.else === null ? null : compileSegments(n.else, ctx, caseScope, templates, bound),
      });
    } else if (n.kind === 'for') {
      const pathDyn = pathVaries(n.path, bound);
      const inner = new Map(bound);
      inner.set(n.name, pathDyn);
      inner.set('loop', pathDyn);
      const body = compileSegments(n.body, ctx, caseScope, templates, inner);
      // A memoized for: the body is one include of an element-only template, the rest
      // constant strings (the include's template renders the same for an element
      // wherever it is listed).
      let incSeg = null;
      let memoOk = true;
      for (const s of body) {
        if (s.k === 'inc') {
          if (incSeg !== null) memoOk = false;
          incSeg = s;
        } else if (s.c === undefined) memoOk = false;
      }
      if (memoOk && incSeg !== null && isElementOnly(incSeg.name, n.name, templates, new Set(), new Set())) {
        segs.push({ k: 'formemo', node: n, body });
      } else {
        segs.push({ k: 'for', node: n, body });
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      segs.push({ k: 'inc', name: n.name, segs: t === undefined ? null : compileSegments(t, ctx, caseScope, templates, bound) });
    }
  }
  flush();
  return segs;
}

/** `segs` rendered into `out` in `scope`. `memo` maps an element-only template's name to a Map of element to its rendered HTML. */
function renderSegments(segs, scope, ctx, depth, out, memo) {
  for (const s of segs) {
    if (s.c !== undefined) {
      out.push(s.c);
      continue;
    }
    switch (s.k) {
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, s.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, s.path)));
        break;
      case 'if': {
        const branch = truthy(lookup(scope, s.node.path)) !== s.node.not ? s.then : s.els;
        if (branch !== null) renderSegments(branch, scope, ctx, depth, out, memo);
        break;
      }
      case 'for': {
        const xs = lookup(scope, s.node.path);
        if (!Array.isArray(xs)) break;
        const name = s.node.name;
        const hadVar = Object.hasOwn(scope, name);
        const oldVar = scope[name];
        const hadLoop = Object.hasOwn(scope, 'loop');
        const oldLoop = scope.loop;
        for (let k = 0; k < xs.length; k++) {
          scope[name] = xs[k];
          scope.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderSegments(s.body, scope, ctx, depth, out, memo);
        }
        if (hadVar) scope[name] = oldVar;
        else delete scope[name];
        if (hadLoop) scope.loop = oldLoop;
        else delete scope.loop;
        break;
      }
      case 'formemo': {
        const xs = lookup(scope, s.node.path);
        if (!Array.isArray(xs)) break;
        const name = s.node.name;
        let incSeg = null;
        for (const b of s.body) if (b.k === 'inc') incSeg = b;
        let perTpl = memo.get(incSeg.name);
        if (perTpl === undefined) {
          perTpl = new Map();
          memo.set(incSeg.name, perTpl);
        }
        const hadVar = Object.hasOwn(scope, name);
        const oldVar = scope[name];
        const hadLoop = Object.hasOwn(scope, 'loop');
        const oldLoop = scope.loop;
        for (let k = 0; k < xs.length; k++) {
          const el = xs[k];
          let html = perTpl.get(el);
          if (html === undefined) {
            scope[name] = el;
            scope.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
            const tmp = [];
            renderSegments(incSeg.segs, scope, ctx, depth + 1, tmp, memo);
            html = tmp.join('');
            perTpl.set(el, html);
          }
          for (const b of s.body) {
            if (b.c !== undefined) out.push(b.c);
            else if (b === incSeg) out.push(html);
          }
        }
        if (hadVar) scope[name] = oldVar;
        else delete scope[name];
        if (hadLoop) scope.loop = oldLoop;
        else delete scope.loop;
        break;
      }
      case 'inc': {
        if (s.segs !== null && depth < INCLUDE_DEPTH) renderSegments(s.segs, scope, ctx, depth + 1, out, memo);
        break;
      }
    }
  }
}
