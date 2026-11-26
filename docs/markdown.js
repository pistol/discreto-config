// Small Markdown renderer for chat replies.
// It builds DOM nodes with createElement and textContent only, never innerHTML,
// because replies can quote email text. Supported: headings, paragraphs,
// bullet and numbered lists, tables, code blocks, **bold**, *italic*, `code`
// and [text](https://link). Links open in a new tab, show their host next to
// the text, and only https links become clickable.

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

// Underscore emphasis is left out on purpose so snake_case names stay intact.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/;

function inline(parent, text) {
  let rest = text;
  while (rest) {
    const m = rest.match(INLINE);
    if (!m) { parent.append(document.createTextNode(rest)); break; }
    if (m.index) parent.append(document.createTextNode(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) {
      const b = el("strong"); inline(b, tok.slice(2, -2)); parent.append(b);
    } else if (tok.startsWith("`")) {
      const c = el("code"); c.textContent = tok.slice(1, -1); parent.append(c);
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      let url = null;
      try { url = new URL(lm[2]); } catch { url = null; }
      if (url && url.protocol === "https:") {
        const a = el("a");
        a.href = url.href; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = lm[1];
        const host = el("span", "host"); host.textContent = ` (${url.host})`;
        parent.append(a, host);
      } else {
        parent.append(document.createTextNode(`${lm[1]} (${lm[2]})`));
      }
    } else {
      const i = el("em"); inline(i, tok.slice(1, -1)); parent.append(i);
    }
    rest = rest.slice(m.index + tok.length);
  }
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function renderMarkdown(text) {
  const root = el("div", "md");
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (/^\s*```/.test(line)) {
      const pre = el("pre"); const code = el("code");
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      code.textContent = body.join("\n"); pre.append(code); root.append(pre);
      continue;
    }

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);   // keep headings small in a chat bubble
      const node = el(`h${level}`); inline(node, h[2]); root.append(node);
      i++; continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const wrap = el("div", "table-wrap");
      const table = el("table");
      const thead = el("thead"); const tr = el("tr");
      for (const c of cells(line)) { const th = el("th"); inline(th, c); tr.append(th); }
      thead.append(tr); table.append(thead);
      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const row = el("tr");
        for (const c of cells(lines[i])) { const td = el("td"); inline(td, c); row.append(td); }
        tbody.append(row); i++;
      }
      table.append(tbody); wrap.append(table); root.append(wrap);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const re = bullet.test(line) ? bullet : numbered;
      const list = el(re === bullet ? "ul" : "ol");
      while (i < lines.length && re.test(lines[i])) {
        const li = el("li"); inline(li, lines[i].match(re)[1]); list.append(li); i++;
      }
      root.append(list);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(lines[i])
           && !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      para.push(lines[i].trim()); i++;
    }
    const p = el("p");
    para.forEach((t, n) => { if (n) p.append(el("br")); inline(p, t); });
    root.append(p);
  }
  return root;
}
