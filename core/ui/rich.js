/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { escapeHTML as e } from "./api.js";

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const CODE_FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const LINK = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;
const INLINE_CODE = /(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g;
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#|\.{1,2}\/)/i;

/** 行内语法：行内代码 / 链接 / 粗体 / 删除线 / 斜体。入参必须已经过转义。 */
export function inlineRich(escaped) {
  // [[img:路径]] / [[voice:路径]] 标记换成媒体元素：先占位，
  // 免得路径里的 * _ 被当成强调定界符。入参已经过转义。
  const medias = [];
  const mediaUrl = (path) => `/api/media?path=${encodeURIComponent(path.replace(/&amp;/g, "&"))}`;
  const withMedia = escaped.replace(/\[\[(img|voice):([^\]]+)\]\]/g, (whole, kind, path) => {
    medias.push(
      kind === "img"
        ? `<img class="msg-media" src="${mediaUrl(path)}" alt="图片" loading="lazy">`
        : `<audio class="msg-audio" controls preload="none" src="${mediaUrl(path)}"></audio>`,
    );
    return `\u0002${medias.length - 1}\u0002`;
  });
  const codes = [];
  const held = withMedia.replace(INLINE_CODE, (whole, run, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 链接先只把 href 换成占位符，标签文字照常走强调逻辑；
  // 否则后面几道 * / _ 替换会把地址里的 * 当成定界符拆开。
  const targets = [];
  const linked = held.replace(LINK, (whole, label, url) => {
    const target = url.replace(/&amp;/g, "&").trim();
    if (!SAFE_URL.test(target)) return whole;
    targets.push(target);
    return `<a href="\u0001${targets.length - 1}\u0001" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  const html = linked
    .replace(/\*\*(?!\s)([^*\n]*?[^\s*])\*\*/g, "<strong>$1</strong>")
    .replace(/~~(?!\s)([^~\n]*?[^\s~])~~/g, "<del>$1</del>")
    .replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, "<em>$1</em>")
    .replace(/(^|[\s(（])_(?!\s)([^_\n]*?[^\s_])_(?=[\s)）.。，,！!？?]|$)/g, "$1<em>$2</em>");
  return html
    .replace(/\u0001(\d+)\u0001/g, (whole, index) => targets[Number(index)] ?? "")
    .replace(
    /\u0000(\d+)\u0000/g,
    (whole, index) => `<code>${codes[Number(index)] ?? ""}</code>`,
  )
    .replace(/\u0002(\d+)\u0002/g, (whole, index) => medias[Number(index)] ?? "");
}

/** 表格行：转义的 `\|` 是单元格内容，不当作分隔符。 */
export function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function renderTable(header, aligns, rows) {
  const cell = (tag, text, index) => {
    const align = aligns[index];
    return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inlineRich(e(text))}</${tag}>`;
  };
  const head = `<thead><tr>${header.map((text, index) => cell("th", text, index)).join("")}</tr></thead>`;
  const body = rows
    .map((row) => `<tr>${header.map((_, index) => cell("td", row[index] ?? "", index)).join("")}</tr>`)
    .join("");
  return `<div class="md-table"><table>${head}<tbody>${body}</tbody></table></div>`;
}

/** 列表：按缩进决定嵌套层级，<ul>/<ol> 由相邻项的有序性切换。 */
function renderListBlock(items) {
  let html = "";
  const stack = [];
  for (const item of items) {
    const tag = item.ordered ? "ol" : "ul";
    while (stack.length && item.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      const start = item.ordered && item.start !== 1 ? ` start="${item.start}"` : "";
      html += `<${tag}${start}>`;
      stack.push({ tag, indent: item.indent });
    } else if (top.tag !== tag) {
      html += `</li></${stack.pop().tag}><${tag}>`;
      stack.push({ tag, indent: item.indent });
    } else {
      html += "</li>";
    }
    html += `<li>${inlineRich(e(item.text))}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/** 块级：代码围栏、GFM 表格、标题、分割线、引用、列表；其余文字按整段转义。 */
export function renderRich(text) {
  const lines = String(text).split("\n");
  const out = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    out.push(inlineRich(e(buffer.join("\n"))));
    buffer = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];

    const fence = CODE_FENCE.exec(line);
    // 反引号围栏的 info string 里不许再有反引号（CommonMark）：
    // 行首三个反引号包住的行内代码不是围栏，否则会把下一行吞进去
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const marker = fence[1];
      flush();
      const lang = fence[2].trim();
      const code = [];
      i += 1;
      while (i < lines.length) {
        const close = CODE_FENCE.exec(lines[i]);
        if (
          close &&
          close[1][0] === marker[0] &&
          close[1].length >= marker.length &&
          close[2].trim() === ""
        )
          break;
        code.push(lines[i]);
        i += 1;
      }
      const cls = lang ? ` class="lang-${e(lang)}"` : "";
      out.push(`<pre class="md-pre"><code${cls}>${e(code.join("\n"))}</code></pre>`);
      continue;
    }

    // 表头与分隔行的格数不一致时不是表格：按普通段落处理，免得吃掉后面的列
    const tableSeparator =
      line.includes("|") && next !== undefined && next.includes("-") && TABLE_SEPARATOR.test(next);
    const header = tableSeparator ? splitTableRow(line) : [];
    const separatorCells = tableSeparator ? splitTableRow(next) : [];
    if (tableSeparator && header.length === separatorCells.length) {
      flush();
      const aligns = separatorCells.map((mark) => {
        const left = mark.startsWith(":");
        const right = mark.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
      });
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      out.push(renderTable(header, aligns, rows));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(6, Math.max(3, heading[1].length + 1));
      out.push(`<h${level}>${inlineRich(e(heading[2]))}</h${level}>`);
      continue;
    }

    if (HR.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const parts = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        parts.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      i -= 1;
      out.push(`<blockquote>${inlineRich(e(parts.join("\n")))}</blockquote>`);
      continue;
    }

    const ulItem = UL_ITEM.exec(line);
    const olItem = OL_ITEM.exec(line);
    if (ulItem || olItem) {
      flush();
      const items = [];
      while (i < lines.length) {
        const ul = UL_ITEM.exec(lines[i]);
        const ol = OL_ITEM.exec(lines[i]);
        const m = ul || ol;
        if (!m) break;
        items.push({
          indent: (ul ? m[1] : m[1]).replace(/\t/g, "  ").length,
          ordered: Boolean(ol),
          start: ol ? Number(ol[2]) : 1,
          text: ul ? ul[2] : ol[3],
        });
        i += 1;
      }
      i -= 1;
      out.push(renderListBlock(items));
      continue;
    }

    buffer.push(line);
  }
  flush();
  return out.join("\n");
}

/** 回复里有可见文字才占气泡：只有一个换行时不把「思考中」撤掉。 */
export const hasVisibleText = (text) => Boolean(String(text ?? "").trim());

/** 等待气泡用和回复同一个头像字。 */
export const avatarLabel = (personaName) => String(personaName || "助手").slice(0, 1);

/** 展开状态的键：优先用页面给的 data-detail-key（会话 + 消息身份），没有就退回序号。 */
const detailKeyOf = (node) => {
  const data = node?.dataset;
  if (!data) return undefined;
  if (data.detailKey !== undefined) return data.detailKey;
  return data.index === undefined ? undefined : "i" + data.index;
};

/** 记住哪些「查看模型原文」是展开的：按消息身份 + 第几个 details 记。 */
export function detailsState(box) {
  const state = new Set();
  if (!box || typeof box.querySelectorAll !== "function") return state;
  box.querySelectorAll(".message[data-index]").forEach((node) => {
    const key = detailKeyOf(node);
    if (key === undefined) return;
    node.querySelectorAll("details").forEach((details, offset) => {
      if (details.open) state.add(`${key}:${offset}`);
    });
  });
  return state;
}

export function applyDetailsState(box, state) {
  if (!box || !state || !state.size || typeof box.querySelectorAll !== "function") return;
  box.querySelectorAll(".message[data-index]").forEach((node) => {
    const key = detailKeyOf(node);
    if (key === undefined) return;
    node.querySelectorAll("details").forEach((details, offset) => {
      if (state.has(`${key}:${offset}`)) details.open = true;
    });
  });
}
