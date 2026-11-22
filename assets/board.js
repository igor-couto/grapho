import { bindBoardDrag } from "./board-drag.js";
import { changeBoardCard, parseBoard, renderBoardMarkdown, setBoardHeading } from "./board-markdown.js";
import { inlineToRuns } from "./doc/markdown.js";
import { serializeRuns } from "./doc/model.js";
import { extensionEnabled, onExtensionsChange } from "./extensions.js";

const STARTER = [
  "# Untitled board",
  "",
  "## To do",
  "- First card: Click its title to edit or drag the card to another column.",
  "",
  "## In progress",
  "",
  "## Done",
  "",
].join("\n");

const library = document.getElementById("boardLibraryLink");
const title = document.getElementById("boardTitle");
const titleInput = document.getElementById("boardTitleInput");
const actions = document.getElementById("boardActions");
const mode = document.getElementById("boardMode");
const addColumn = document.getElementById("boardAddColumn");
const errorNotice = document.getElementById("boardError");
const errorMessage = document.getElementById("boardErrorMessage");
const retry = document.getElementById("boardRetry");
const view = document.getElementById("boardView");
const description = document.getElementById("boardDescription");
const columns = document.getElementById("boardColumns");
const empty = document.getElementById("boardEmpty");
const editor = document.getElementById("boardEditor");
const enableHint = document.getElementById("boardEnableHint");
const source = document.getElementById("boardSource");
const itemDialog = document.getElementById("boardItemDialog");
const itemHeading = document.getElementById("boardItemHeading");
const itemTitle = document.getElementById("boardItemTitle");
const cardFields = document.getElementById("boardCardFields");
const cardDescription = document.getElementById("boardCardDescription");

const id = location.pathname.split("/").at(-1);
const endpoint = "/api/documents/" + encodeURIComponent(id) + "/board";
const params = new URLSearchParams(location.search);
const libraryParams = new URLSearchParams();
const space = params.get("space");
const query = params.get("q");
if (space) libraryParams.set("space", space);
if (query) {
  libraryParams.set("q", query);
  libraryParams.set("from", id);
}
if (libraryParams.size) library.search = libraryParams.toString();

let isDraft = location.pathname.startsWith("/board/new/");
let loaded = false;
let editing = false;
let savePromise = null;
let saveTimer;
let savedSource = "";
let savedTitle = "Untitled board";
let lineEnding = "\n";
let board;
let itemEdit;
const cancelCardDrag = bindBoardDrag(columns, moveCard);

mode.addEventListener("click", () => setMode(!editing, true));
retry.addEventListener("click", () => loaded ? saveBoard() : loadBoard());
source.addEventListener("input", queueSave);
library.addEventListener("click", async (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || (!savePromise && !hasChanges())) return;
  event.preventDefault();
  while (savePromise || hasChanges()) {
    if (!await saveBoard()) return;
  }
  location.assign(library.href);
});
title.addEventListener("click", () => {
  titleInput.value = board.title || savedTitle;
  title.hidden = true;
  titleInput.hidden = false;
  titleInput.focus();
  titleInput.select();
});
titleInput.addEventListener("blur", () => finishTitleEdit(true));
titleInput.addEventListener("keydown", (event) => {
  if (event.isComposing || !["Enter", "Escape"].includes(event.key)) return;
  event.preventDefault();
  finishTitleEdit(event.key === "Enter");
  title.focus();
});
addColumn.addEventListener("click", () => openColumn("Add column", -1, "", addColumn));
itemTitle.addEventListener("input", () => itemTitle.setCustomValidity(""));
document.getElementById("boardItemCancel").addEventListener("click", () => itemDialog.close());
document.getElementById("boardItemForm").addEventListener("submit", acceptItem);
itemDialog.addEventListener("close", () => {
  itemEdit?.returnFocus?.focus();
  itemEdit = null;
});
itemDialog.addEventListener("click", (event) => {
  if (event.target === itemDialog) itemDialog.close();
});
document.addEventListener("keydown", (event) => {
  if (
    loaded && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    && event.key.toLowerCase() === "s" && !document.querySelector("dialog[open]")
  ) {
    event.preventDefault();
    saveBoard();
  }
});
onExtensionsChange(() => {
  if (loaded && mode.hidden === extensionEnabled("boards")) setMode(editing);
});

loadBoard();

async function loadBoard() {
  try {
    if (isDraft) {
      source.value = STARTER;
    } else {
      const response = await requestBoard(endpoint);
      source.value = response.markdown;
      savedTitle = response.title;
      lineEnding = response.markdown.match(/\r\n?|\n/)?.[0] ?? "\n";
    }
    savedSource = source.value;
    loaded = true;
    actions.hidden = false;
    showError("");
    setMode(false);
  } catch (error) {
    showError(error.message);
  }
}

function setMode(edit, focus = false) {
  cancelCardDrag();
  finishTitleEdit(true);
  const enabled = extensionEnabled("boards");
  const modeHadFocus = document.activeElement === mode;
  editing = edit || !enabled;
  mode.hidden = !enabled;
  title.disabled = editing;
  addColumn.hidden = editing;
  if (editing && itemDialog.open) itemDialog.close();
  enableHint.hidden = enabled;
  mode.textContent = editing ? "View board" : "Edit Markdown";
  editor.hidden = !editing;
  view.hidden = editing;
  updateTitle(editing ? "" : renderBoard());
  if ((focus || modeHadFocus) && editing) source.focus();
  else if (focus) mode.focus();
}

function updateTitle(heading) {
  title.innerHTML = serializeRuns(inlineToRuns(heading).map(({ href, ...run }) => run));
  if (!title.textContent.trim()) title.textContent = savedTitle;
  document.title = title.textContent + " - Grapho";
}

function finishTitleEdit(commit) {
  if (titleInput.hidden) return;
  const name = titleInput.value.trim();
  titleInput.hidden = true;
  title.hidden = false;
  if (!commit || !name || name === (board.title || savedTitle)) return;

  source.value = setBoardHeading(source.value, 1, board.titleLine, name);
  board = parseBoard(source.value);
  updateTitle(board.title);
  queueSave();
}

function hasChanges() {
  return source.value !== savedSource && (!isDraft || Boolean(source.value.trim()));
}

function syncUnloadGuard() {
  if (hasChanges() || savePromise) window.addEventListener("beforeunload", protectChanges);
  else window.removeEventListener("beforeunload", protectChanges);
}

function queueSave() {
  window.clearTimeout(saveTimer);
  syncUnloadGuard();
  if (savePromise) return;
  if (hasChanges()) saveTimer = window.setTimeout(saveBoard, 350);
  else showError("");
}

function protectChanges(event) {
  event.preventDefault();
  event.returnValue = true;
}

function saveBoard() {
  window.clearTimeout(saveTimer);
  if (savePromise) return savePromise;
  if (!loaded || !hasChanges()) return Promise.resolve(true);
  savePromise = persistBoard(source.value);
  syncUnloadGuard();
  return savePromise;
}

async function persistBoard(markdown) {
  const target = new URL(endpoint, location.origin);
  if (isDraft) {
    target.searchParams.set("draft", "true");
    if (space && space !== "general") target.searchParams.set("space", space);
  }

  let saved = false;
  try {
    const response = await requestBoard(target, markdown.replaceAll("\n", lineEnding));
    savedSource = markdown;
    savedTitle = response.title;
    if (isDraft) {
      history.replaceState(null, "", "/doc/" + id + location.search + location.hash);
      isDraft = false;
    }
    updateTitle(editing ? "" : board.title);
    showError("");
    saved = true;
  } catch (error) {
    showError(error.message);
  } finally {
    savePromise = null;
    syncUnloadGuard();
    if (saved && hasChanges()) queueSave();
  }
  return saved;
}

async function requestBoard(target, markdown) {
  let response;
  try {
    response = await fetch(target, {
      method: markdown === undefined ? "GET" : "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: markdown === undefined ? undefined : JSON.stringify({ markdown }),
    });
  } catch {
    throw new Error("Couldn't reach Grapho. Check that the server is still running.");
  }
  if (response.status === 401) {
    const next = location.pathname + location.search + location.hash;
    if (markdown === undefined) location.assign("/login?" + new URLSearchParams({ next }));
    throw new Error("Your session ended. Sign in from another tab and try again.");
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || "Grapho couldn't access this board.");
  }
  return response.json();
}

function showError(message) {
  if (errorMessage.textContent !== message) errorMessage.textContent = message;
  errorNotice.hidden = !message;
}

function renderBoard() {
  board = parseBoard(source.value);
  description.innerHTML = renderBoardMarkdown(board.description);
  description.hidden = !board.description;
  empty.hidden = board.columns.length > 0;
  columns.hidden = !board.columns.length;
  const fragment = document.createDocumentFragment();
  board.columns.forEach((column, index) => fragment.append(renderColumn(column, index)));
  columns.replaceChildren(fragment);
  return board.title;
}

function renderColumn(column, index) {
  const section = document.createElement("section");
  section.className = "board-column";
  section.dataset.column = index;

  const heading = document.createElement("h2");
  const titleButton = boardButton("board-heading-button", plainTitle(column.title));
  titleButton.title = "Rename column";
  titleButton.addEventListener("click", () => {
    const current = board.columns[index];
    openColumn("Rename column", current.start, current.title, titleButton, index);
  });
  heading.append(titleButton);
  const addCard = boardButton("board-add-card", "+ Add card");
  addCard.addEventListener("click", () => openCard(index, board.columns[index].cards.length, addCard));
  section.append(heading, addCard);
  if (column.description) section.append(markdownElement(column.description));

  const list = document.createElement("ul");
  list.className = "board-card-list";
  list.setAttribute("role", "list");
  for (const [position, card] of column.cards.entries()) {
    const item = document.createElement("li");
    item.className = "board-card";
    item.dataset.card = position;
    const cardTitle = document.createElement("h3");
    const edit = boardButton("board-heading-button", plainTitle(card.title) || "Untitled card");
    item.addEventListener("click", (event) => {
      if (!event.target.closest("a")) openCard(index, position, edit);
    });
    cardTitle.append(edit);
    const grip = document.createElement("span");
    grip.className = "board-card-grip";
    grip.setAttribute("aria-hidden", "true");
    grip.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="7" cy="5" r="1.2"/><circle cx="13" cy="5" r="1.2"/><circle cx="7" cy="10" r="1.2"/><circle cx="13" cy="10" r="1.2"/><circle cx="7" cy="15" r="1.2"/><circle cx="13" cy="15" r="1.2"/></svg>';
    item.append(cardTitle, grip);
    if (card.description) item.append(markdownElement(card.description));
    list.append(item);
  }
  section.append(list);
  return section;
}

function boardButton(className, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.setAttribute("aria-haspopup", "dialog");
  return button;
}

function plainTitle(value) {
  return inlineToRuns(value).map((run) => run.text).join("");
}

function openColumn(heading, line, value, returnFocus, column) {
  itemEdit = { line, value, returnFocus, column };
  showItemDialog(heading, value);
}

function openCard(column, position, returnFocus) {
  itemEdit = { column, position, returnFocus };
  const card = board.columns[column].cards[position];
  cardDescription.value = card?.description ?? "";
  showItemDialog(card ? "Edit card" : "Add card", card?.title ?? "");
}

function showItemDialog(heading, value) {
  itemHeading.textContent = heading;
  itemTitle.value = value;
  itemTitle.setCustomValidity("");
  cardFields.hidden = itemEdit.line !== undefined;
  itemDialog.showModal();
  itemTitle.select();
}

function acceptItem(event) {
  event.preventDefault();
  const name = itemTitle.value.trim();
  if (!name) {
    itemTitle.setCustomValidity("Enter a title.");
    itemTitle.reportValidity();
    return;
  }

  if (itemEdit.line !== undefined) {
    if (name !== itemEdit.value) {
      applyBoardSource(setBoardHeading(source.value, 2, itemEdit.line, name));
      if (itemEdit.column !== undefined) {
        itemEdit.returnFocus = columns.children[itemEdit.column]?.querySelector("h2 button");
      }
    }
  } else {
    const { column: columnIndex, position } = itemEdit;
    const column = board.columns[columnIndex];
    const card = column.cards[position];
    const details = cardDescription.value.trim();
    if (card?.title !== name || card.description !== details) {
      const before = column.cards[position + 1];
      applyBoardSource(changeBoardCard(source.value, card, column, before, { title: name, description: details }));
      itemEdit.returnFocus = columns.children[columnIndex]?.querySelectorAll(".board-card h3 button")[position];
    }
  }
  itemDialog.close();
}

function applyBoardSource(markdown) {
  if (source.value === markdown) return;
  source.value = markdown;
  updateTitle(renderBoard());
  queueSave();
}

function moveCard(fromColumn, fromCard, toColumn, before) {
  const card = board.columns[fromColumn].cards[fromCard];
  const column = board.columns[toColumn];
  const markdown = changeBoardCard(source.value, card, column, column.cards[before]);
  if (markdown === source.value) return null;
  let position = before ?? column.cards.length;
  if (fromColumn === toColumn && fromCard < position) position--;
  applyBoardSource(markdown);
  return columns.children[toColumn].querySelector(`.board-card[data-card="${position}"]`);
}

function markdownElement(markdown) {
  const element = document.createElement("div");
  element.className = "board-markdown";
  element.innerHTML = renderBoardMarkdown(markdown);
  return element;
}
