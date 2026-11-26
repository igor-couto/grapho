// Tests for the table block: model, layout, editing, painting, Markdown mode,
// clipboard, and PDF. editor.test.js owns the harness runner and runs these
// after its own tests (see window.__extraTests); this file only registers tests
// plus a small editor of its own on a separate paper.

import { DocEditor } from "/assets/doc/input.js";
import {
  blockEntry,
  caretPoint,
  ensureFonts,
  pointToOffset,
} from "/assets/doc/layout.js";
import {
  blockLength,
  blockText,
  createBlock,
  emptyTable,
  isTableBlock,
  parseDocument,
  serializeDocument,
  tableCellRanges,
} from "/assets/doc/model.js";
import { richToSource, sourceToRich, tableToMarkdown } from "/assets/doc/markdown.js";
import { blocksFromPastedHtml, selectionHtml } from "/assets/doc/clipboard.js";
import { buildPdf } from "/assets/doc/pdf.js";

window.__extraTests = window.__extraTests || [];

function test(name, fn) {
  window.__extraTests.push({ name: "table " + name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message}: expected ${expected} ± ${tolerance}, got ${Number.isFinite(actual) ? actual.toFixed(2) : actual}`,
    );
  }
}

function raf() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle() {
  await raf();
  await raf();
}

let host = null;
let editor = null;

function teardown() {
  if (host) {
    host.remove();
    host = null;
    editor = null;
  }
}

async function open(blocks, width) {
  teardown();
  host = document.createElement("div");
  host.innerHTML =
    '<article class="paper" style="width:760px">' +
    '<div class="prose" style="width:' +
    (width || 700) +
    'px">' +
    '<div class="doc-content"></div>' +
    '<div class="doc-overlay"><div class="doc-caret"></div></div>' +
    '<textarea class="doc-input"></textarea>' +
    "</div></article>";
  document.body.appendChild(host);
  const root = host.querySelector(".prose");
  const textarea = host.querySelector(".doc-input");
  editor = new DocEditor({
    root,
    textarea,
    onLayout: null,
    onChange: null,
    onSelection: null,
    onImageSelect: null,
    onImageDragStart: null,
    onSave: null,
    onLink: null,
    onPasteImages: null,
    onSourceFormat: null,
    onSourceWrap: null,
  });
  editor.bind();
  await ensureFonts("Harbour morning light 0123");
  editor.setDocument(blocks.length ? blocks : [createBlock("p", [])]);
  await settle();
  return editor;
}

function tableOf(blocks = editor.getDocument()) {
  return blocks.find((block) => isTableBlock(block)) || null;
}

function cellText(runs) {
  return (runs || []).map((run) => run.text).join("");
}

function type(text) {
  editor.textarea.value = text;
  editor.handleInput();
}

function press(key, options) {
  editor.handleKeyDown({ key, preventDefault() {}, ...options });
}

/* --------------------------------------------------------------------------
   Model and HTML
   -------------------------------------------------------------------------- */

test("canonical HTML parses and serializes back", async () => {
  const html =
    "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>" +
    "<tbody><tr><td>Tea</td><td><b>2</b></td></tr></tbody></table>";
  const blocks = parseDocument(html);
  assertEqual(blocks.length, 1, "one block");
  assertEqual(blocks[0].type, "table", "a table block");
  assertEqual(serializeDocument(blocks), html, "round trips byte for byte");
  assertEqual(blocks[0].rows.length, 2, "header and body row");
  assertEqual(blocks[0].rows[0][0][0].text, "Name", "header cell text");
  assertEqual(blocks[0].rows[1][1][0].b, true, "inline marks are kept");
});

test("a bare table gets a header row and rectangular rows", async () => {
  const blocks = parseDocument("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>");
  const table = blocks[0];
  assertEqual(table.rows.length, 2, "two rows");
  assertEqual(table.rows[1].length, 2, "the short row is padded");
  assertEqual(blockText(table), "a\tb\nc\t", "separators are tab and newline");
  assertEqual(blockLength(table), 6, "flat length counts the separators");
});

/* --------------------------------------------------------------------------
   Editing
   -------------------------------------------------------------------------- */

test("typing and Tab fill cells and append a row", async () => {
  await open([emptyTable(2, 1), createBlock("p", [])]);
  const table = tableOf();
  editor.collapseTo({ block: 0, offset: 0 });
  type("Name");
  press("Tab");
  type("Qty");
  press("Tab");
  type("Tea");
  press("Tab");
  type("2");
  press("Tab");
  const result = tableOf();
  assertEqual(result.rows.length, 3, "Tab at the last cell appends a row");
  assertEqual(cellText(result.rows[0][0]), "Name", "header cell one");
  assertEqual(cellText(result.rows[0][1]), "Qty", "header cell two");
  assertEqual(cellText(result.rows[1][0]), "Tea", "body cell one");
  assertEqual(cellText(result.rows[1][1]), "2", "body cell two");
  assertEqual(cellText(result.rows[2][0]), "", "the appended row starts empty");
  assertEqual(editor.getSelection().focus.block, 0, "the caret stays in the table");
  assertEqual(
    editor.getSelection().focus.offset,
    tableCellRanges(result)[4].start,
    "the caret is in the appended row's first cell",
  );
});

test("Shift+Tab goes back a cell and stops at the first", async () => {
  await open([emptyTable(2, 1), createBlock("p", [])]);
  const table = tableOf();
  editor.collapseTo({ block: 0, offset: tableCellRanges(table)[2].start });
  press("Tab", { shiftKey: true });
  assertEqual(editor.getSelection().focus.offset, tableCellRanges(table)[1].start, "previous cell");
  press("Tab", { shiftKey: true });
  press("Tab", { shiftKey: true });
  assertEqual(editor.getSelection().focus.offset, tableCellRanges(table)[0].start, "the first cell stops it");
});

test("Enter is a hard break inside a cell", async () => {
  await open([emptyTable(2, 1), createBlock("p", [])]);
  editor.collapseTo({ block: 0, offset: 0 });
  type("one");
  press("Enter");
  type("two");
  const table = tableOf();
  assertEqual(cellText(table.rows[0][0]), "one\ntwo", "the cell keeps both lines");
  assert(serializeDocument([table]).includes("one<br>two"), "saved as a hard break");
  assertEqual(editor.getSelection().focus.offset, 7, "the caret follows the inserted break");
  editor.undo();
  assertEqual(cellText(tableOf().rows[0][0]), "one\n", "undo removes the typed text after the break");
  editor.undo();
  assertEqual(cellText(tableOf().rows[0][0]), "one", "another undo removes the break");
});

test("Backspace at the start of a cell and Delete at its end do nothing", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "keep" }];
  await open([table, createBlock("p", [])]);
  const ranges = tableCellRanges(tableOf());
  editor.collapseTo({ block: 0, offset: ranges[1].start });
  const before = serializeDocument(editor.getDocument());
  press("Backspace");
  assertEqual(serializeDocument(editor.getDocument()), before, "the cell border is not a join");
  editor.collapseTo({ block: 0, offset: ranges[1].end });
  press("Delete");
  assertEqual(serializeDocument(editor.getDocument()), before, "Delete at a cell end does nothing");
});

test("deleting a whole-table selection clears every cell and keeps the grid", async () => {
  const table = emptyTable(2, 2);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2" }];
  await open([table, createBlock("p", [])]);
  const ranges = tableCellRanges(tableOf());
  editor.setSelection(
    { block: 0, offset: ranges[0].start },
    { block: 0, offset: blockLength(tableOf()) },
  );
  press("Backspace");
  const result = tableOf();
  assertEqual(result.rows.length, 3, "the grid keeps its shape");
  assertEqual(result.rows[0].length, 2, "and its columns");
  for (const row of result.rows) {
    for (const runs of row) {
      assertEqual(cellText(runs), "", "every cell is empty");
    }
  }
  assertEqual(blockText(result), "\t\n\t\n\t", "only the separators remain");
  editor.undo();
  assertEqual(cellText(tableOf().rows[0][0]), "Name", "undo restores the cells in one step");
});

test("selecting across a table and a paragraph removes the table whole", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Grid" }];
  await open([createBlock("p", [{ text: "before" }]), table, createBlock("p", [{ text: "after" }])]);
  editor.setSelection({ block: 0, offset: 3 }, { block: 2, offset: 2 });
  press("Backspace");
  const blocks = editor.getDocument();
  assert(!blocks.some((block) => isTableBlock(block)), "the table is gone");
  assertEqual(blockText(blocks[0]), "bef", "the text before the selection stays");
  assertEqual(blockText(blocks[1]), "ter", "the text after the selection stays");
});

test("arrow down keeps the same column", async () => {
  const table = emptyTable(2, 2);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2" }];
  await open([table, createBlock("p", [])]);
  const ranges = tableCellRanges(tableOf());
  editor.collapseTo({ block: 0, offset: ranges[1].start });
  press("ArrowDown");
  assertEqual(editor.getSelection().focus.offset, ranges[3].start, "the same column one row down");
  press("ArrowUp");
  assertEqual(editor.getSelection().focus.offset, ranges[1].start, "and back up");
});

test("row and column commands change the grid around the caret", async () => {
  await open([emptyTable(2, 1), createBlock("p", [])]);
  editor.collapseTo({ block: 0, offset: 0 });
  editor.tableInsertRowAtCaret(false);
  assertEqual(tableOf().rows.length, 3, "a row below");
  editor.tableInsertColumnAtCaret(false);
  assertEqual(tableOf().rows[0].length, 3, "a column to the right");
  editor.tableDeleteColumnAtCaret();
  assertEqual(tableOf().rows[0].length, 2, "the column is removed");
  editor.tableDeleteRowAtCaret();
  assertEqual(tableOf().rows.length, 2, "the row is removed");
  editor.deleteTableAtCaret();
  assert(!isTableBlock(editor.getDocument()[0]), "the table becomes a paragraph");
});

test("inserting a table splits a paragraph and leaves a paragraph after", async () => {
  await open([createBlock("p", [{ text: "Before after" }])]);
  editor.collapseTo({ block: 0, offset: 6 });
  editor.insertTable(2, 1);
  const blocks = editor.getDocument();
  assertEqual(blocks.length, 3, "head, table, tail");
  assertEqual(blockText(blocks[0]), "Before", "the line is split at the caret");
  assert(isTableBlock(blocks[1]), "the table is between the halves");
  assertEqual(blockText(blocks[2]), " after", "the rest continues below");
  assertEqual(editor.getSelection().focus.block, 1, "the caret is in the grid");
  assertEqual(editor.getSelection().focus.offset, 0, "at its first cell");
});

test("toolbar marks and links apply inside a table cell", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  await open([table, createBlock("p", [])]);
  const ranges = tableCellRanges(tableOf());
  editor.setSelection({ block: 0, offset: ranges[0].start }, { block: 0, offset: ranges[0].end });
  editor.toggleMark("b");
  assertEqual(tableOf().rows[0][0][0].b, true, "the header cell text is bold");
  editor.undo();
  assertEqual(tableOf().rows[0][0][0].b, undefined, "undo removes the mark in one step");
  assertEqual(tableOf().rows[0][1][0].text, "Qty", "the other cells are untouched");

  editor.collapseTo({ block: 0, offset: ranges[0].start });
  assertEqual(editor.setLink("https://example.com/", "Example"), true, "a link can be inserted in a cell");
  assertEqual(tableOf().rows[0][0][0].href, "https://example.com/", "the cell run carries the link");
  assertEqual(cellText(tableOf().rows[0][0]), "ExampleName", "the label is inserted at the caret");
});

test("the cell options button follows the cell under the pointer", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  await open([table, createBlock("p", [])]);
  const entry = blockEntry(editor.layout, 0);
  const cell = entry.table.rows[1].cells[1];
  const rect = host.querySelector(".prose").getBoundingClientRect();
  const clientX = rect.left + cell.x + cell.width / 2;
  const clientY = rect.top + cell.top + cell.height / 2;
  const found = editor.view.tableCellAtPoint(clientX, clientY);
  assert(found, "the point maps to a table cell");
  assertEqual(found.cell.row, 1, "the body row");
  assertEqual(found.cell.column, 1, "the second column");

  const tool = editor.view.showTableCellTool(found.entry, found.cell);
  assert(tool, "the options button exists");
  assertEqual(tool.hidden, false, "hovering shows it");
  const left = parseFloat(tool.style.left);
  const top = parseFloat(tool.style.top);
  assert(left >= cell.x && left + 24 <= cell.x + cell.width + 1, "sits inside the cell's right edge");
  assertClose(top, cell.top + 4, 0.5, "sits near the cell's top edge");
  assertEqual(tool.dataset.row, "1", "carries its row");
  assertEqual(tool.dataset.column, "1", "carries its column");
  assertEqual(tool.getAttribute("aria-haspopup"), "menu", "opens a menu");

  editor.view.hideTableCellTool();
  assertEqual(tool.hidden, true, "leaving the cell hides it");
});

test("the table shortcuts add a column right and a row below", async () => {
  await open([emptyTable(2, 1), createBlock("p", [])]);
  editor.collapseTo({ block: 0, offset: 0 });
  editor.handleKeyDown({ key: "ArrowRight", ctrlKey: true, altKey: true, preventDefault() {} });
  assertEqual(tableOf().rows[0].length, 3, "the column was added to the right");
  assertEqual(editor.getSelection().focus.offset, tableCellRanges(tableOf())[1].start, "the caret is in it");
  editor.handleKeyDown({ key: "ArrowDown", ctrlKey: true, altKey: true, preventDefault() {} });
  assertEqual(tableOf().rows.length, 3, "the row was added below");
  assertEqual(
    editor.getSelection().focus.offset,
    tableCellRanges(tableOf())[4].start,
    "the caret is in the new row's cell",
  );
});

/* --------------------------------------------------------------------------
   Layout and painting
   -------------------------------------------------------------------------- */

test("layout fits columns to the paper and places every cell", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "A name that is long enough to wrap inside its column" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2" }];
  await open([table, createBlock("p", [])], 520);
  const entry = blockEntry(editor.layout, 0);
  assert(entry.table, "the entry carries table geometry");
  const columns = entry.table.columns;
  assertEqual(columns.length, 2, "two columns");
  let sum = 0;
  for (const column of columns) {
    assert(column.width > 0, "a column has width");
    sum += column.width;
  }
  assertClose(sum, 520, 1, "the columns fill the paper");
  assertEqual(entry.table.rows.length, 2, "two rows");
  assert(entry.table.rows[1].height >= 24, "a row is at least one line tall");

  const ranges = tableCellRanges(table);
  const cell = entry.table.rows[1].cells[0];
  const atStart = caretPoint(entry, ranges[2].start, null);
  assert(atStart, "the caret has a point in the cell");
  assert(
    atStart.x >= cell.x && atStart.x <= cell.x + cell.width,
    "the caret sits inside the cell's x range",
  );
  assert(
    atStart.y >= cell.top && atStart.y <= cell.top + cell.height,
    "and inside its row",
  );
  const clicked = pointToOffset(entry, cell.x + cell.width / 2, cell.top + cell.height / 2);
  assert(
    clicked >= ranges[2].start && clicked <= ranges[2].end,
    "a click in the cell maps to its offset range",
  );
});

test("the view paints the frame, header wash, rules, and table lines", async () => {
  const table = emptyTable(3, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[1][1] = [{ text: "2" }];
  await open([table, createBlock("p", [])]);
  const block = host.querySelectorAll(".doc-content > .doc-block")[0];
  assert(block, "the table block is painted");
  assertEqual(block.querySelectorAll(".doc-table-frame").length, 1, "one outer frame");
  assertEqual(block.querySelectorAll(".doc-table-head").length, 1, "one header wash");
  assertEqual(
    block.querySelectorAll(".doc-table-rule.is-column").length,
    2,
    "one rule between the three columns",
  );
  assertEqual(block.querySelectorAll(".doc-table-rule.is-row").length, 1, "one rule between the rows");
  const lines = Array.from(block.querySelectorAll(":scope > .doc-line"));
  assert(lines.length >= 2, "one line per painted cell line");
  for (const line of lines) {
    assert(line.classList.contains("is-table"), "table text uses the table style");
  }
});

/* --------------------------------------------------------------------------
   Markdown mode, export, clipboard, PDF
   -------------------------------------------------------------------------- */

test("Markdown mode shows a table as a GFM pipe table", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2", b: true }];
  const conversion = richToSource([table]);
  assertEqual(conversion.blocks.length, 3, "header, delimiter, and one body row line");
  assertEqual(
    conversion.blocks.map((block) => blockText(block)).join("\n"),
    "| Name | Qty |\n| --- | --- |\n| Tea | **2** |",
    "the source is a portable pipe table",
  );
  const back = sourceToRich(conversion.blocks);
  assertEqual(back.blocks.length, 1, "the lines parse back to one block");
  assert(isTableBlock(back.blocks[0]), "as a table");
  assertEqual(serializeDocument(back.blocks), serializeDocument([table]), "with the same cells");
});

test("a pipe table typed or pasted in Markdown mode becomes a table", async () => {
  const lines = [
    "| Trait | Bonus | Drawback |",
    "| --- | --- | --- |",
    "| Stalwart | +1 Physical | −1 Intelligence |",
    "| Keen-eyed | +1 Perception | −1 Charisma |",
  ];
  const source = lines.map((text) => {
    const block = createBlock("p", [{ text }]);
    block.source = true;
    return block;
  });
  const conversion = sourceToRich(source);
  assertEqual(conversion.blocks.length, 1, "the rows group into one block");
  const table = conversion.blocks[0];
  assert(isTableBlock(table), "the block is a table");
  assertEqual(table.rows.length, 3, "header plus two body rows");
  assertEqual(table.rows[0][2][0].text, "Drawback", "the header cell");
  assertEqual(table.rows[1][1][0].text, "+1 Physical", "a body cell");
  assertEqual(tableToMarkdown(table), lines.join("\n"), "and it writes back unchanged");
});

test("a table with a cell Markdown cannot carry keeps the HTML source line", async () => {
  // A leading space cannot survive GFM's cell trimming, so the pipe form is
  // refused and the serialized HTML escape shape carries the table instead.
  const table = emptyTable(1, 0);
  table.rows[0][0] = [{ text: " leading" }];
  const conversion = richToSource([table]);
  assertEqual(conversion.blocks.length, 1, "one HTML line");
  assert(blockText(conversion.blocks[0]).startsWith("<table>"), "the escape shape");
  const back = sourceToRich(conversion.blocks);
  assertEqual(back.blocks.length, 1, "one block");
  assertEqual(serializeDocument(back.blocks), serializeDocument([table]), "and the same table");
});

test("the exported Markdown is a GFM pipe table", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea", b: true }];
  table.rows[1][1] = [{ text: "a|b" }];
  assertEqual(
    tableToMarkdown(table),
    "| Name | Qty |\n| --- | --- |\n| **Tea** | a\\|b |",
    "header, delimiter, body, escaped pipe",
  );
  const spaced = emptyTable(1, 0);
  spaced.rows[0][0] = [{ text: " leading" }];
  assertEqual(tableToMarkdown(spaced), null, "leading whitespace falls back to the HTML form");
});

test("copy and paste keep a table as a table", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2" }];
  const blocks = [table];
  const html = selectionHtml(blocks, { block: 0, offset: 0 }, { block: 0, offset: blockLength(table) });
  assertEqual(html, serializeDocument([table]), "a whole table copies as table HTML");
  const pasted = blocksFromPastedHtml(html);
  assertEqual(pasted.length, 1, "one pasted block");
  assert(isTableBlock(pasted[0]), "it comes back as a table");
  assertEqual(serializeDocument(pasted), serializeDocument([table]), "with the same cells");
});

test("PDF export draws the table text", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Harbour" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2" }];
  const pdf = await buildPdf([table], "Table document");
  const text = new TextDecoder("latin1").decode(pdf);
  assert(text.startsWith("%PDF-1.4"), "a PDF file");
  assert(text.includes("Harbour"), "the header text is in the content stream");
  assert(text.includes("Tea"), "and a body cell");
});

test("pasting a table inserts a grid and leaves a paragraph after it", async () => {
  const table = emptyTable(2, 1);
  table.rows[0][0] = [{ text: "Name" }];
  table.rows[0][1] = [{ text: "Qty" }];
  table.rows[1][0] = [{ text: "Tea" }];
  table.rows[1][1] = [{ text: "2" }];
  await open([createBlock("p", [])]);
  const data = new DataTransfer();
  data.setData("text/html", serializeDocument([table]));
  editor.textarea.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
  );
  const blocks = editor.getDocument();
  assert(isTableBlock(blocks[0]), "the pasted table becomes the first block");
  assertEqual(serializeDocument([blocks[0]]), serializeDocument([table]), "with the same cells");
  assertEqual(blocks[1]?.type, "p", "a paragraph follows the pasted grid");
});

/* --------------------------------------------------------------------------
   Cleanup
   -------------------------------------------------------------------------- */

test("cleans up its test page", async () => {
  teardown();
});
