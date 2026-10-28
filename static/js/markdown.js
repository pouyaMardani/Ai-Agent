

const TOKEN = "\u0000";

export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHref(url) {
  const cleaned = String(url === null || url === undefined ? "" : url)
    .trim()
    .replace(/[\u0000-\u0020\u007F]+/g, "");
  if (!cleaned) return null;
  if (!/^(?:https?:\/\/[\w.-]+|mailto:[\w.+-]+@[\w.-]+|tel:[\w+.-]+|\/(?!\/)|#)/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function safeLangClass(lang) {
  const clean = String(lang || "").replace(/[^a-z0-9+#._-]/gi, "");
  return clean ? ' class="language-' + clean + '"' : "";
}

function stash(tokens, html) {
  tokens.push(html);
  return TOKEN + (tokens.length - 1) + TOKEN;
}

function restore(text, tokens) {
  return text.replace(new RegExp(TOKEN + "(\\d+)" + TOKEN, "g"), function (match, index) {
    return tokens[Number(index)] || "";
  });
}

function autoLink(url, tokens) {
  const trimmed = url.replace(/[.,;:!?]+$/, "");
  const rest = url.slice(trimmed.length);
  const href = safeHref(trimmed);
  if (!href) return url;
  return (
    stash(
      tokens,
      '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + trimmed + "</a>"
    ) + rest
  );
}

export function renderInline(escaped) {
  const tokens = [];
  let text = String(escaped === null || escaped === undefined ? "" : escaped);

  text = text.replace(/`([^`\n]+)`/g, function (match, code) {
    return stash(tokens, "<code>" + code + "</code>");
  });

  text = text.replace(/\[([^\]\n]{1,400})\]\(([^()\s]+)\)/g, function (match, label, url) {
    const href = safeHref(url);
    if (!href) return label;
    return stash(
      tokens,
      '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>"
    );
  });

  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  text = text.replace(/(^|[\s(])(https?:\/\/[\w.-][^\s<)]*)/g, function (match, before, url) {
    return before + autoLink(url, tokens);
  });

  return restore(text, tokens);
}

function codeBlock(code, lang) {
  return (
    '<div class="code-block">' +
    '<div class="code-block__head">' +
    '<span class="code-block__lang">' +
    escapeHtml(lang || "code") +
    "</span>" +
    '<button type="button" class="code-copy" data-copy-code data-icon="copy">' +
    '<span class="code-copy__label">Copy</span>' +
    "</button>" +
    "</div>" +
    "<pre><code" +
    safeLangClass(lang) +
    ">" +
    escapeHtml(code) +
    "</code></pre>" +
    "</div>"
  );
}

const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function separatorRow(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function startsBlock(lines, index) {
  const line = lines[index];
  if (/^\s*(`{3,}|~{3,})/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (LIST_MARKER.test(line)) return true;
  if (line.includes("|") && index + 1 < lines.length && separatorRow(lines[index + 1])) return true;
  return false;
}

function renderList(lines, start, indent) {
  const first = lines[start].match(LIST_MARKER);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = lines[i].match(LIST_MARKER);

    if (!match) {
      if (items.length > 0 && /^\s+\S/.test(lines[i])) {
        items[items.length - 1] += " " + renderInline(escapeHtml(lines[i].trim()));
        i += 1;
        continue;
      }
      break;
    }

    const itemIndent = match[1].length;
    if (itemIndent < indent) break;

    if (itemIndent >= indent + 2) {
      const nested = renderList(lines, i, itemIndent);
      if (items.length === 0) items.push(nested.html);
      else items[items.length - 1] += nested.html;
      i = nested.next;
      continue;
    }

    if (/\d/.test(match[2]) !== ordered) break;
    items.push(renderInline(escapeHtml(match[3])));
    i += 1;
  }

  const tag = ordered ? "ol" : "ul";
  const body = items.map((item) => "<li>" + item + "</li>").join("");
  return { html: "<" + tag + ">" + body + "</" + tag + ">", next: i };
}

export function renderMarkdown(source) {
  const text = String(source === null || source === undefined ? "" : source).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (fence) {
      const marker = fence[1].charAt(0);
      const closer = new RegExp("^\\s*" + marker + "{3,}\\s*$");
      const body = [];
      i += 1;
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(codeBlock(body.join("\n"), fence[2]));
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      out.push("<h" + level + ">" + renderInline(escapeHtml(heading[2])) + "</h" + level + ">");
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote>" + renderMarkdown(quoted.join("\n")) + "</blockquote>");
      continue;
    }

    const listStart = line.match(LIST_MARKER);
    if (listStart) {
      const list = renderList(lines, i, listStart[1].length);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && separatorRow(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push(
        '<div class="table-wrap"><table><thead><tr>' +
          head.map((cell) => "<th>" + renderInline(escapeHtml(cell)) + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows
            .map((row) => "<tr>" + row.map((cell) => "<td>" + renderInline(escapeHtml(cell)) + "</td>").join("") + "</tr>")
            .join("") +
          "</tbody></table></div>"
      );
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (paragraph.length === 0) {
      i += 1;
      continue;
    }
    out.push("<p>" + renderInline(escapeHtml(paragraph.join("\n"))).replace(/\n/g, "<br />") + "</p>");
  }

  return out.join("");
}