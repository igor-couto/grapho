import { sourceToRich } from "./doc/markdown.js";
import { createBlock, serializeDocument } from "./doc/model.js";

const HEADING = /^(#{1,2})[ \t]+(.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(\S.*)$/;
const FENCE = /^(`{3,})([^`]*)$/;
const CARD_TITLE = /^((?:\\.|[^:\\])*)(?::(.*))?$/;

function openingFence(line) {
  return FENCE.exec(line.trim());
}

function closesFence(line, marker) {
  const end = line.trim();
  return end.length >= marker.length && /^`+$/.test(end);
}

function dedent(lines) {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim()) indent = Math.min(indent, line.match(/^[ \t]*/)[0].length);
  }
  return lines.map((line) => line.slice(indent)).join("\n").trimEnd();
}

function cardMarkdown(lines) {
  const first = lines.findIndex((line) => line.trim());
  const last = lines.findLastIndex((line) => line.trim());
  if (first < 0) return "";
  const open = openingFence(lines[first]);
  // A card can wrap its description in a plain or Markdown-labeled fence.
  // Longer fences let the description contain Markdown code blocks of its own.
  if (open && /^(?:md|markdown)?$/i.test(open[2].trim()) && last > first && closesFence(lines[last], open[1])) {
    return dedent(lines.slice(first + 1, last)).trimStart();
  }
  return dedent(lines.slice(first, last + 1));
}

export function parseBoard(markdown) {
  const lines = sourceLines(markdown);
  const intro = [];
  const columns = [];
  let title = "";
  let titleLine = -1;
  let column;
  let card;
  let fence;
  let cardIndent = Infinity;
  const firstContent = lines.findIndex((line) => line.trim());

  for (const [index, line] of lines.entries()) {
    if (fence) {
      (card?.lines ?? column?.lines ?? intro).push(line);
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading?.[1] === "#" && index === firstContent) {
      title = heading[2].trim();
      titleLine = index;
      continue;
    }
    if (heading?.[1] === "##" && heading[2].trim()) {
      column = { title: heading[2].trim(), start: index, lines: [], cards: [] };
      columns.push(column);
      card = undefined;
      cardIndent = Infinity;
      continue;
    }

    const bullet = column && BULLET.exec(line);
    if (bullet) {
      const indent = bullet[1].replaceAll("\t", "    ").length;
      if (indent <= cardIndent) {
        cardIndent = indent;
        const [, name, inline = ""] = CARD_TITLE.exec(bullet[2]) ?? [null, bullet[2]];
        card = { title: name.replaceAll("\\:", ":").trim(), inline: inline.trim(), start: index, indent: bullet[1], lines: [] };
        column.cards.push(card);
        continue;
      }
    }

    (card?.lines ?? column?.lines ?? intro).push(line);
    fence = openingFence(line)?.[1];
  }

  return {
    title,
    titleLine,
    openFence: fence,
    description: intro.join("\n").trim(),
    columns: columns.map(({ title, start, lines: notes, cards }, index) => ({
      title,
      start,
      end: columns[index + 1]?.start ?? lines.length,
      openFence: index === columns.length - 1 ? fence : undefined,
      description: dedent(notes),
      cards: cards.map(({ title, inline, start, indent, lines }, cardIndex) => ({
        title,
        start,
        end: start + 2 + lines.findLastIndex((line) => line.trim()),
        indent,
        openFence: index === columns.length - 1 && cardIndex === cards.length - 1 ? fence : undefined,
        description: [inline, cardMarkdown(lines)].filter(Boolean).join("\n\n"),
      })),
    })),
  };
}

function sourceLines(markdown) {
  return markdown.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
}

function joinLines(markdown, lines) {
  const newline = markdown.match(/\r\n?|\n/)?.[0] ?? "\n";
  return (markdown.startsWith("\uFEFF") ? "\uFEFF" : "") + lines.join(newline);
}

export function setBoardHeading(markdown, level, line, title) {
  const lines = sourceLines(markdown);
  const heading = "#".repeat(level) + " " + title;
  if (line >= 0) lines[line] = heading;
  else if (level === 1) lines.unshift(heading, "");
  else {
    const end = lines.findLastIndex((entry) => entry.trim()) + 1;
    const openFence = parseBoard(markdown).openFence;
    const addition = end ? ["", heading] : [heading];
    if (openFence) addition.unshift(openFence);
    lines.splice(end, 0, ...addition);
  }
  return joinLines(markdown, lines);
}

export function removeBoardCard(markdown, card) {
  if (!card) return markdown;
  const lines = sourceLines(markdown);
  if (card.start < 0 || card.end <= card.start || card.end > lines.length) return markdown;
  lines.splice(card.start, card.end - card.start);
  return joinLines(markdown, lines);
}

export function changeBoardCard(markdown, card, column, before, changes) {
  if (card && before === card && !changes) return markdown;
  const lines = sourceLines(markdown);
  const neighbors = column.cards.filter((entry) => entry !== card);
  const next = card && before === card ? column.cards[column.cards.indexOf(card) + 1] : before;
  if (card && column.cards.includes(card) && !changes
      && next === column.cards[column.cards.indexOf(card) + 1]) return markdown;

  const indent = next?.indent ?? neighbors.at(-1)?.indent ?? card?.indent ?? "";
  const location = next?.start ?? neighbors.at(-1)?.end
    ?? (column.cards.includes(card) ? card.start : column.end);
  // Keep the spacing at the end of the destination column.
  let insert = location;
  while (insert > column.start + 1 && !lines[insert - 1].trim()) insert--;

  let block;
  if (changes) {
    const name = changes.title.replaceAll(":", "\\:");
    const details = changes.description.trim();
    if (details.includes("\n")) {
      let ticks = 2;
      for (const match of details.matchAll(/`+/g)) ticks = Math.max(ticks, match[0].length);
      const fence = "`".repeat(ticks + 1);
      block = ["- " + name + ":", "  " + fence, ...details.split("\n").map((line) => "    " + line), "  " + fence]
        .map((line) => indent + line);
    } else {
      block = [indent + "- " + name + (details ? ": " + details : "")];
    }
  } else {
    block = lines.slice(card.start, card.end).map((line) =>
      line && line.startsWith(card.indent) ? indent + line.slice(card.indent.length) : line,
    );
    if (card.openFence) block.push(indent + card.openFence);
  }

  if (!next && column.openFence && (!card || column.cards.at(-1) !== card)) {
    block.unshift(column.openFence);
  }
  if (card) {
    lines.splice(card.start, card.end - card.start);
    if (insert > card.start) insert -= card.end - card.start;
  }
  lines.splice(insert, 0, ...block);
  return joinLines(markdown, lines);
}

// The editor's Markdown parser expects bare backtick fences. Translate fence
// markers instead of changing code lines, including shorter fences inside them.
function boardSourceLines(markdown) {
  let fence;
  return markdown.split("\n").map((line) => {
    if (fence) {
      if (!closesFence(line, fence)) return line;
      const closing = "`".repeat(fence.length);
      fence = undefined;
      return closing;
    }
    fence = openingFence(line)?.[1];
    return fence ? "`".repeat(fence.length) : line;
  });
}

export function renderBoardMarkdown(markdown) {
  if (!markdown) return "";
  const lines = boardSourceLines(markdown).map((line) => createBlock("p", [{ text: line }]));
  return serializeDocument(sourceToRich(lines).blocks);
}
