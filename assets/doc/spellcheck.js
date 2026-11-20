import { blockLength, isAtomicBlock } from "./model.js";

const CHECK_DELAY_MS = 250;

export class Spellcheck {
  constructor({ editor, menu, positionMenu, beforeOpen, onError }) {
    this.editor = editor;
    this.menu = menu;
    this.positionMenu = positionMenu;
    this.beforeOpen = beforeOpen;
    this.onError = onError;
    this.blocks = null;
    this.enabled = false;
    this.checked = new WeakSet();
    this.worker = null;
    this.timer = null;
    this.pending = null;
    this.active = null;
    this.requestId = 0;
    this.status = menu.querySelector("[role=status]");
    this.choices = menu.querySelector(".spelling-suggestions");

    menu.addEventListener("click", (event) => this.choose(event));
    menu.addEventListener("keydown", (event) => this.navigate(event));
  }

  setEnabled(enabled) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.schedule();
    } else {
      clearTimeout(this.timer);
      this.timer = null;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      this.checked = new WeakSet();
      this.editor.view.clearSpelling();
      this.close(true);
    }
  }

  update(blocks) {
    if (blocks === this.blocks) return;
    this.blocks = blocks;
    this.close(true);
    if (this.enabled) this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, CHECK_DELAY_MS);
  }

  check() {
    if (!this.blocks || this.pending) return;
    const blocks = this.blocks.filter((block) =>
      !this.checked.has(block) && !block.source && block.type !== "code" && !isAtomicBlock(block) && blockLength(block));
    if (!blocks.length) return;

    try {
      if (!this.worker) {
        const worker = new Worker(new URL("../spellcheck/worker.js", import.meta.url));
        this.worker = worker;
        worker.addEventListener("message", ({ data }) => {
          if (this.worker === worker) this.receive(data);
        });
        worker.addEventListener("error", (error) => {
          if (this.worker === worker) this.fail(error.message);
        });
      }
      this.pending = { document: this.blocks, blocks };
      this.worker.postMessage({ type: "check", blocks: blocks.map(proseForCheck) });
    } catch (error) {
      this.fail(error);
    }
  }

  receive(data) {
    if (data.type === "failed") {
      this.fail(data.message);
    } else if (data.type === "checked") {
      const { document, blocks } = this.pending;
      this.pending = null;
      const indices = new Map(this.blocks.map((block, index) => [block, index]));
      for (const [i, block] of blocks.entries()) {
        const index = indices.get(block);
        if (index === undefined) continue;
        this.checked.add(block);
        this.editor.view.setSpelling(index, data.ranges[i]);
      }
      if (!this.timer && document !== this.blocks) this.check();
    } else if (data.type === "suggested" && this.active?.id === data.id) {
      this.showSuggestions(data.suggestions);
    }
  }

  fail(error) {
    console.warn("Grapho spellcheck:", error);
    this.setEnabled(false);
    this.onError();
  }

  open(match) {
    if (!match || !this.worker || this.editor.composing) return false;
    const { index, range, element } = match;
    this.beforeOpen();
    this.active = { index, range, element, block: this.blocks[index], id: ++this.requestId };
    this.choices.replaceChildren();
    this.status.textContent = "Finding suggestions…";
    this.menu.hidden = false;
    this.positionMenu(this.menu, element);
    this.menu.focus({ preventScroll: true });
    this.worker.postMessage({ type: "suggest", id: this.active.id, word: range.word });
    return true;
  }

  showSuggestions(suggestions) {
    this.status.textContent = suggestions.length ? "" : "No suggestions";
    for (const suggestion of suggestions) {
      const button = document.createElement("button");
      button.className = "menu-item";
      button.type = "button";
      button.dataset.replacement = suggestion;
      button.textContent = suggestion;
      this.choices.appendChild(button);
    }
    this.reposition();
    if (document.activeElement === this.menu) this.menu.querySelector("button").focus({ preventScroll: true });
  }

  reposition() {
    if (!this.active) return;
    if (!this.active.element.isConnected) this.close(true);
    else this.positionMenu(this.menu, this.active.element);
  }

  close(restoreFocus) {
    if (this.menu.hidden) return;
    const ownedFocus = this.menu.contains(document.activeElement);
    this.menu.hidden = true;
    this.active = null;
    if (restoreFocus && ownedFocus) this.editor.focusEditor();
  }

  choose(event) {
    const button = event.target.closest("button");
    if (!button || !this.active) return;
    const { index, block, range } = this.active;
    this.close(false);
    if (button.hasAttribute("data-replacement")) {
      this.editor.replaceMisspelling(index, block, range, button.dataset.replacement);
    } else {
      this.editor.view.ignoreSpelling(range.word);
    }
    this.editor.focusEditor();
  }

  navigate(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [...this.menu.querySelectorAll("button")];
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === "ArrowDown" ? current + 1 : (current <= 0 ? buttons.length - 1 : current - 1);
      event.preventDefault();
      buttons[next % buttons.length].focus({ preventScroll: true });
    }
  }
}

function proseForCheck(block) {
  let text = "";
  const codeRanges = [];
  for (const run of block.runs) {
    if (run.code) codeRanges.push({ start: text.length, end: text.length + run.text.length });
    text += run.text;
  }
  return { text, codeRanges };
}
