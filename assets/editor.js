(function () {
  "use strict";

  var state = {
    documentId: null,
    loaded: false,
    dirty: false,
    saving: false,
    deleting: false,
    saveTimer: null,
    retryTimer: null,
    savePromise: null,
    saveErrorNotified: false,
    lastRange: null,
    linkRange: null,
    linkAnchor: null,
    toastTimer: null,
  };

  var els = {};

  var TOGGLE_COMMANDS = [
    "bold",
    "italic",
    "underline",
    "strikeThrough",
    "insertUnorderedList",
    "insertOrderedList",
  ];

  var INLINE_FORMATS = {
    bold: ["B", "STRONG"],
    italic: ["I", "EM"],
    underline: ["U"],
    strikeThrough: ["STRIKE", "S", "DEL"],
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.saveStatus = document.getElementById("saveStatus");
    els.backToLibrary = document.getElementById("backToLibrary");
    els.documentMenuButton = document.getElementById("documentMenuButton");
    els.documentMenu = document.getElementById("documentMenu");
    els.formatToolbar = document.getElementById("formatToolbar");
    els.blockStyle = document.getElementById("blockStyle");
    els.linkButton = document.getElementById("linkButton");
    els.imageButton = document.getElementById("imageButton");
    els.imageInput = document.getElementById("imageInput");
    els.imageMenu = document.getElementById("imageMenu");
    els.paper = document.getElementById("paper");
    els.documentTitle = document.getElementById("documentTitle");
    els.editor = document.getElementById("editor");
    els.loadError = document.getElementById("loadError");
    els.toast = document.getElementById("toast");

    els.linkDialog = document.getElementById("linkDialog");
    els.linkForm = document.getElementById("linkForm");
    els.linkTitle = document.getElementById("linkTitle");
    els.linkDescription = document.getElementById("linkDescription");
    els.linkInput = document.getElementById("linkInput");
    els.linkError = document.getElementById("linkError");
    els.linkApply = document.getElementById("linkApply");
    els.linkRemove = document.getElementById("linkRemove");
    els.linkCancel = document.getElementById("linkCancel");

    els.deleteDialog = document.getElementById("deleteDialog");
    els.deleteForm = document.getElementById("deleteForm");
    els.deleteConfirm = document.getElementById("deleteConfirm");
    els.deleteCancel = document.getElementById("deleteCancel");

    bindEvents();
    loadDocument();
  }

  function bindEvents() {
    els.documentTitle.addEventListener("input", function () {
      if (!state.loaded) {
        return;
      }
      updatePageTitle();
      markDirty();
    });

    els.documentTitle.addEventListener("blur", normalizeTitleField);
    els.documentTitle.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && state.loaded) {
        event.preventDefault();
        focusEditorAtEnd();
      }
    });

    els.editor.addEventListener("input", handleEditorInput);
    els.editor.addEventListener("paste", handlePaste);
    els.editor.addEventListener("drop", handleDrop);
    els.editor.addEventListener("click", handleEditorClick);
    els.editor.addEventListener("focus", updateToolbarState);
    els.editor.addEventListener("keydown", handleEditorKeydown);

    els.imageButton.addEventListener("click", openImagePicker);
    els.imageInput.addEventListener("change", handleImagePicked);
    els.imageMenu.addEventListener("click", handleImageMenuClick);

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mousedown", handleDocumentPointer);

    window.addEventListener("scroll", closeImageMenu, { passive: true });
    window.addEventListener("resize", closeImageMenu);

    els.saveStatus.addEventListener("click", function () {
      if (!state.loaded || state.saving) {
        return;
      }
      if (state.dirty) {
        saveNow();
      }
    });

    els.formatToolbar.addEventListener("mousedown", function (event) {
      if (event.target.closest("button")) {
        // Keep the writing selection alive while a toolbar control is pressed.
        event.preventDefault();
      }
    });

    els.formatToolbar.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-command]");
      if (!button || button.disabled) {
        return;
      }
      runCommand(button.dataset.command);
    });

    els.blockStyle.addEventListener("change", function () {
      if (!state.loaded) {
        return;
      }

      focusEditorForCommand();
      useSemanticMarkup();
      var value = els.blockStyle.value;
      try {
        document.execCommand("formatBlock", false, "<" + value + ">");
      } catch (error) {
        // Older browsers can simply ignore a block style they do not know.
      }
      notifyEditorChanged();
      updateToolbarState();
    });

    els.linkButton.addEventListener("click", openLinkDialog);

    els.documentMenuButton.addEventListener("click", function (event) {
      event.stopPropagation();
      toggleDocumentMenu();
    });

    els.documentMenu.addEventListener("click", handleDocumentMenuAction);

    document.addEventListener("click", function (event) {
      if (!event.target.closest(".menu-wrap")) {
        closeDocumentMenu();
      }
    });

    document.addEventListener("keydown", handleGlobalKeydown);

    document.querySelectorAll('a[href="/"]').forEach(function (link) {
      link.addEventListener("click", handleHomeLink);
    });

    els.linkForm.addEventListener("submit", applyLink);
    els.linkCancel.addEventListener("click", closeLinkDialog);
    els.linkRemove.addEventListener("click", removeLink);
    els.linkInput.addEventListener("input", function () {
      els.linkError.hidden = true;
    });
    els.linkDialog.addEventListener("click", function (event) {
      if (event.target === els.linkDialog) {
        closeLinkDialog();
      }
    });
    els.linkDialog.addEventListener("close", function () {
      state.linkRange = null;
      state.linkAnchor = null;
      if (state.loaded) {
        els.editor.focus({ preventScroll: true });
      }
    });

    els.deleteConfirm.addEventListener("click", deleteDocument);
    els.deleteCancel.addEventListener("click", closeDeleteDialog);
    els.deleteForm.addEventListener("submit", function (event) {
      event.preventDefault();
    });
    els.deleteDialog.addEventListener("click", function (event) {
      if (event.target === els.deleteDialog && !state.deleting) {
        closeDeleteDialog();
      }
    });
    els.deleteDialog.addEventListener("close", function () {
      if (state.loaded) {
        els.documentMenuButton.focus();
      }
    });
    els.deleteDialog.addEventListener("cancel", function (event) {
      if (state.deleting) {
        event.preventDefault();
      }
    });

    window.addEventListener("pagehide", persistBeforeLeaving);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") {
        persistBeforeLeaving();
      }
    });
    window.addEventListener("online", function () {
      if (state.loaded && state.dirty && !state.saving) {
        saveNow();
      }
    });
  }

  function documentIdFromPath() {
    var match = window.location.pathname.match(/^\/doc\/([^/]+)\/?$/);
    if (!match) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return null;
    }
  }

  async function loadDocument() {
    state.documentId = documentIdFromPath();
    if (!state.documentId) {
      showLoadFailure({ status: 404 });
      return;
    }

    try {
      var document = await request(
        "/api/documents/" + encodeURIComponent(state.documentId),
      );
      applyDocument(document);
    } catch (error) {
      showLoadFailure(error);
    }
  }

  function applyDocument(document) {
    state.loaded = true;
    state.dirty = false;

    els.documentTitle.value = document.title || "Untitled document";
    els.documentTitle.disabled = false;
    els.editor.innerHTML = document.content || "";
    els.editor.setAttribute("contenteditable", "true");
    els.paper.setAttribute("aria-busy", "false");

    setToolbarEnabled(true);
    els.documentMenuButton.disabled = false;
    els.saveStatus.disabled = false;

    updatePageTitle();
    updateEditorPlaceholder();
    hideSaveStatus();
    updateToolbarState();
    useSemanticMarkup();

    var params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") {
      window.history.replaceState(null, "", window.location.pathname);
      els.documentTitle.focus();
      els.documentTitle.select();
    }
  }

  function showLoadFailure(error) {
    var notFound = error && error.status === 404;
    var titleNode = els.loadError.querySelector("h1");
    var textNode = els.loadError.querySelector("p");
    var markNode = els.loadError.querySelector(".load-error-mark");

    els.paper.setAttribute("aria-busy", "false");
    els.paper.querySelector(".paper-head").hidden = true;
    els.editor.hidden = true;
    els.loadError.hidden = false;

    markNode.textContent = notFound ? "404" : "!";
    titleNode.textContent = notFound
      ? "This page isn't here."
      : "Couldn't open this document.";
    textNode.textContent = notFound
      ? "It may have been deleted, or the link might be incomplete."
      : "Grapho couldn't reach the document. Check the server, then refresh the page.";

    hideSaveStatus();
    els.saveStatus.disabled = true;
    els.documentTitle.disabled = true;
    els.documentMenuButton.disabled = true;
    setToolbarEnabled(false);
    document.title = notFound
      ? "Document not found — Grapho"
      : "Couldn't open document — Grapho";
  }

  function setToolbarEnabled(enabled) {
    els.formatToolbar
      .querySelectorAll("button, select")
      .forEach(function (control) {
        control.disabled = !enabled;
      });
  }

  function useSemanticMarkup() {
    // Without this, Chromium applies formatting as inline CSS styles, which the
    // app's strict Content-Security-Policy correctly refuses. The editor only
    // stores semantic tags such as <b>, <i>, and <u>.
    try {
      document.execCommand("styleWithCSS", false, false);
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (error) {
      // The fallback browser-native formatting is handled by the trust
      // boundary in the Rust API.
    }
  }

  function handleEditorInput() {
    if (!state.loaded) {
      return;
    }
    closeImageMenu();
    updateEditorPlaceholder();
    notifyEditorChanged();
  }

  function notifyEditorChanged() {
    if (!state.loaded) {
      return;
    }

    state.dirty = true;
    scheduleSave();
  }

  function markDirty() {
    notifyEditorChanged();
  }

  function normalizeTitle(raw) {
    var cleaned = String(raw || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    var characters = Array.from(cleaned);
    if (characters.length > 200) {
      cleaned = characters.slice(0, 200).join("");
    }
    return cleaned || "Untitled document";
  }

  function normalizeTitleField() {
    if (!state.loaded) {
      return;
    }
    var normalized = normalizeTitle(els.documentTitle.value);
    if (els.documentTitle.value !== normalized) {
      els.documentTitle.value = normalized;
      updatePageTitle();
      notifyEditorChanged();
    }
  }

  function updatePageTitle() {
    var title = String(els.documentTitle.value || "").trim() || "Untitled document";
    document.title = title + " — Grapho";
  }

  function updateEditorPlaceholder() {
    var text = els.editor.innerText.replace(/\u00a0/g, " ").trim();
    var hasNonText = Boolean(els.editor.querySelector("hr, img"));
    els.editor.dataset.empty = text || hasNonText ? "false" : "true";
  }

  function buildPayload() {
    return {
      title: normalizeTitle(els.documentTitle.value),
      content: getEditorContent(),
    };
  }

  function getEditorContent() {
    var text = els.editor.innerText.replace(/\u00a0/g, " ").trim();
    var hasNonText = Boolean(els.editor.querySelector("hr, img"));
    return text || hasNonText ? els.editor.innerHTML : "";
  }

  function scheduleSave(delay) {
    if (!state.loaded) {
      return;
    }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(function () {
      state.saveTimer = null;
      saveNow();
    }, typeof delay === "number" ? delay : 900);
  }

  function saveNow() {
    if (!state.loaded) {
      return Promise.resolve(false);
    }
    if (state.saving) {
      return state.savePromise || Promise.resolve(false);
    }

    window.clearTimeout(state.saveTimer);
    window.clearTimeout(state.retryTimer);
    state.saveTimer = null;
    state.retryTimer = null;

    if (!state.dirty) {
      return Promise.resolve(true);
    }

    var payload = buildPayload();
    state.dirty = false;
    state.saving = true;

    state.savePromise = (async function () {
      try {
        await request(
          "/api/documents/" + encodeURIComponent(state.documentId),
          {
            method: "PUT",
            body: payload,
          },
        );

        state.saving = false;
        state.saveErrorNotified = false;
        hideSaveStatus();

        if (state.dirty) {
          scheduleSave(350);
        }
        return true;
      } catch (error) {
        state.saving = false;
        state.dirty = true;
        showSaveStatus();

        if (!state.saveErrorNotified) {
          showToast(
            error.userMessage ||
              "Your latest changes couldn't be saved. Grapho will keep trying.",
            true,
          );
          state.saveErrorNotified = true;
        }

        window.clearTimeout(state.retryTimer);
        state.retryTimer = window.setTimeout(function () {
          if (state.dirty && !state.saving) {
            saveNow();
          }
        }, 5000);
        return false;
      } finally {
        state.savePromise = null;
      }
    })();

    return state.savePromise;
  }

  async function flushBeforeLeaving() {
    if (!state.loaded) {
      return true;
    }

    var attempts = 0;
    while ((state.dirty || state.saving) && attempts < 2) {
      await saveNow();
      attempts += 1;
    }
    return !state.dirty && !state.saving;
  }

  function handleHomeLink(event) {
    if (
      !state.loaded ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    if (!state.dirty && !state.saving) {
      return;
    }

    event.preventDefault();
    flushBeforeLeaving().then(function (saved) {
      if (saved) {
        window.location.assign("/");
      } else {
        showToast(
          "Your latest changes couldn't be saved. Try once more before leaving.",
          true,
        );
      }
    });
  }

  function persistBeforeLeaving() {
    if (!state.loaded || !state.dirty || state.saving) {
      return;
    }

    var payload = buildPayload();
    try {
      fetch("/api/documents/" + encodeURIComponent(state.documentId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {
        // This is a best-effort save for the final seconds of a page visit.
      });
    } catch (error) {
      // Older browsers may reject keepalive requests; the normal save path
      // remains unchanged.
    }
  }

  function hideSaveStatus() {
    els.saveStatus.hidden = true;
  }

  function showSaveStatus() {
    els.saveStatus.hidden = false;
  }

  /* -----------------------------------------------------------------------
     Formatting
     ----------------------------------------------------------------------- */

  function handleSelectionChange() {
    if (!state.loaded) {
      return;
    }

    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    var range = selection.getRangeAt(0);
    if (!rangeInsideEditor(range)) {
      return;
    }

    state.lastRange = range.cloneRange();
    updateToolbarState();
  }

  function rangeInsideEditor(range) {
    return (
      range &&
      (els.editor.contains(range.commonAncestorContainer) ||
        range.commonAncestorContainer === els.editor)
    );
  }

  function restoreEditorSelection(range) {
    els.editor.focus({ preventScroll: true });
    if (!range) {
      return false;
    }

    try {
      var selection = window.getSelection();
      if (!selection) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (error) {
      return false;
    }
  }

  function focusEditorForCommand() {
    if (state.lastRange && restoreEditorSelection(state.lastRange)) {
      return;
    }
    focusEditorAtEnd();
  }

  function focusEditorAtEnd() {
    els.editor.focus({ preventScroll: true });
    var selection = window.getSelection();
    if (!selection) {
      return;
    }
    var range = document.createRange();
    range.selectNodeContents(els.editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    state.lastRange = range.cloneRange();
  }

  function runCommand(command) {
    if (!state.loaded || !command) {
      return;
    }

    if (command !== "undo" && command !== "redo") {
      focusEditorForCommand();
    } else {
      els.editor.focus({ preventScroll: true });
    }

    if (INLINE_FORMATS[command] && formatIsInherited(command)) {
      showToast(
        "That formatting comes from the block style. Choose Paragraph to remove the block style.",
      );
      updateToolbarState();
      return;
    }

    useSemanticMarkup();
    try {
      document.execCommand(command, false, null);
    } catch (error) {
      // Contenteditable command support varies slightly across browsers.
    }

    notifyEditorChanged();
    updateEditorPlaceholder();
    updateToolbarState();
  }

  /// A browser may report bold/italic as active because of the surrounding
  /// block's CSS rather than an inline tag. Trying to remove that formatting
  /// would require an inline style attribute, which the app intentionally does
  /// not allow. Treat it as a no-op with a hint instead.
  function formatIsInherited(command) {
    var tags = INLINE_FORMATS[command];
    if (!tags) {
      return false;
    }

    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }

    if (!document.queryCommandState(command)) {
      return false;
    }

    var node = selection.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    if (!node || !(node instanceof Element) || !els.editor.contains(node)) {
      return false;
    }

    var cursor = node;
    while (cursor && cursor !== els.editor) {
      if (tags.indexOf(cursor.tagName) !== -1) {
        return false;
      }
      cursor = cursor.parentElement;
    }

    return true;
  }

  function handleEditorKeydown(event) {
    if (!state.loaded || event.altKey || event.shiftKey) {
      return;
    }
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    var key = event.key.toLocaleLowerCase();
    var command = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null;
    if (!command) {
      return;
    }

    event.preventDefault();
    runCommand(command);
  }

  function updateToolbarState() {
    if (!state.loaded) {
      return;
    }

    TOGGLE_COMMANDS.forEach(function (command) {
      var button = els.formatToolbar.querySelector(
        '[data-command="' + command + '"]',
      );
      if (!button) {
        return;
      }

      var active = false;
      try {
        active = document.queryCommandState(command);
      } catch (error) {
        active = false;
      }
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    var block = "";
    try {
      block = String(document.queryCommandValue("formatBlock") || "")
        .replace(/[<>\s]/g, "")
        .toLowerCase();
    } catch (error) {
      block = "";
    }

    var blockMap = {
      p: "p",
      div: "p",
      h1: "h1",
      h2: "h2",
      blockquote: "blockquote",
      pre: "pre",
    };
    els.blockStyle.value = blockMap[block] || "p";

    var selection = window.getSelection();
    var anchor =
      selection && selection.rangeCount > 0
        ? closestLink(selection.getRangeAt(0))
        : null;
    els.linkButton.setAttribute("aria-pressed", anchor ? "true" : "false");
  }

  function closestLink(range) {
    if (!range) {
      return null;
    }

    var node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    if (!node || !(node instanceof Element)) {
      return null;
    }
    return node.closest("a[href]");
  }

  /* -----------------------------------------------------------------------
     Links
     ----------------------------------------------------------------------- */

  function openLinkDialog() {
    if (!state.loaded) {
      return;
    }
    closeDocumentMenu();

    var range = state.lastRange;
    var anchor = range ? closestLink(range) : null;
    if (!anchor && (!range || range.collapsed)) {
      showToast("Select a word or phrase first, then add a link.");
      return;
    }

    state.linkRange = range ? range.cloneRange() : null;
    state.linkAnchor = anchor;
    els.linkInput.value = anchor ? anchor.getAttribute("href") || "" : "";
    els.linkTitle.textContent = anchor ? "Edit link" : "Add a link";
    els.linkDescription.textContent = anchor
      ? "Change where this link points, or remove it entirely."
      : "Link the selected text to a web address.";
    els.linkApply.textContent = anchor ? "Update link" : "Add link";
    els.linkRemove.hidden = !anchor;
    els.linkError.hidden = true;

    if (!els.linkDialog.open) {
      els.linkDialog.showModal();
    }
    window.requestAnimationFrame(function () {
      els.linkInput.focus();
      els.linkInput.select();
    });
  }

  function closeLinkDialog() {
    if (els.linkDialog.open) {
      els.linkDialog.close();
    }
  }

  function normalizeLink(raw) {
    var value = String(raw || "").trim();
    if (!value) {
      return null;
    }

    var candidate = /^[a-z][a-z0-9+.-]*:/i.test(value)
      ? value
      : "https://" + value;

    try {
      var url = new URL(candidate);
      if (
        url.protocol !== "http:" &&
        url.protocol !== "https:" &&
        url.protocol !== "mailto:"
      ) {
        return null;
      }
      if (url.protocol === "mailto:" && !value.toLowerCase().startsWith("mailto:")) {
        return null;
      }
      return url.href;
    } catch (error) {
      return null;
    }
  }

  function applyLink(event) {
    event.preventDefault();
    if (!state.loaded) {
      return;
    }

    var url = normalizeLink(els.linkInput.value);
    if (!url) {
      els.linkError.hidden = false;
      els.linkInput.focus();
      return;
    }

    var range = state.linkRange || state.lastRange;
    var existingAnchor = state.linkAnchor;
    if (!range) {
      closeLinkDialog();
      return;
    }

    // While a modal <dialog> is open, the page is inert. Close it before
    // focusing the editor and applying the command, otherwise the browser has
    // no editable focus target and createLink is a no-op.
    closeLinkDialog();

    window.requestAnimationFrame(function () {
      if (!restoreEditorSelection(range)) {
        return;
      }

      useSemanticMarkup();
      if (existingAnchor && existingAnchor.isConnected) {
        existingAnchor.setAttribute("href", url);
        existingAnchor.setAttribute("rel", "noopener noreferrer");
      } else {
        try {
          document.execCommand("createLink", false, url);
        } catch (error) {
          // Fall through to the range-based implementation below.
        }

        var currentSelection = window.getSelection();
        var created =
          currentSelection && currentSelection.rangeCount > 0
            ? closestLink(currentSelection.getRangeAt(0))
            : null;
        if (!created) {
          wrapRangeWithLink(range, url);
          currentSelection = window.getSelection();
          created =
            currentSelection && currentSelection.rangeCount > 0
              ? closestLink(currentSelection.getRangeAt(0))
              : null;
        }
        if (created) {
          created.setAttribute("rel", "noopener noreferrer");
        }
      }

      notifyEditorChanged();
      updateToolbarState();
      els.editor.focus({ preventScroll: true });
    });
  }

  function wrapRangeWithLink(range, url) {
    var anchor = document.createElement("a");
    anchor.setAttribute("href", url);
    anchor.setAttribute("rel", "noopener noreferrer");

    try {
      range.surroundContents(anchor);
    } catch (error) {
      var fragment = range.extractContents();
      anchor.appendChild(fragment);
      range.insertNode(anchor);
    }

    var selection = window.getSelection();
    if (selection) {
      var linkedRange = document.createRange();
      linkedRange.selectNodeContents(anchor);
      selection.removeAllRanges();
      selection.addRange(linkedRange);
    }
  }

  function removeLink() {
    var anchor = state.linkAnchor;
    if (!anchor || !anchor.isConnected) {
      closeLinkDialog();
      return;
    }

    var parent = anchor.parentNode;
    while (anchor.firstChild) {
      parent.insertBefore(anchor.firstChild, anchor);
    }
    parent.removeChild(anchor);
    parent.normalize();

    closeLinkDialog();
    notifyEditorChanged();
    updateToolbarState();
    els.editor.focus({ preventScroll: true });
  }

  /* -----------------------------------------------------------------------
     Images
     ----------------------------------------------------------------------- */

  var IMAGE_MAX_EDGE = 1600;
  var IMAGE_MAX_DATA_URL = 1500000;
  var IMAGE_PASSTHROUGH_BYTES = 600 * 1024;
  var activeImage = null;

  function openImagePicker() {
    if (!state.loaded) {
      return;
    }
    els.imageInput.value = "";
    els.imageInput.click();
  }

  function handleImagePicked() {
    var files = Array.prototype.slice.call(els.imageInput.files || []);
    els.imageInput.value = "";
    if (files.length) {
      addImages(files);
    }
  }

  function imageFilesFrom(list) {
    var files = [];
    Array.prototype.forEach.call(list || [], function (file) {
      if (file && /^image\//.test(file.type)) {
        files.push(file);
      }
    });
    return files;
  }

  function clipboardImages(clipboard) {
    if (!clipboard) {
      return [];
    }

    var files = [];
    if (clipboard.items && clipboard.items.length) {
      Array.prototype.forEach.call(clipboard.items, function (item) {
        if (item.kind !== "file" || !/^image\//.test(item.type)) {
          return;
        }
        var file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      });
    }

    return files.length ? files : imageFilesFrom(clipboard.files);
  }

  async function addImages(files) {
    var images = imageFilesFrom(files);
    if (!images.length) {
      showToast("Only image files can go in a document.", true);
      return;
    }

    var added = 0;
    for (var index = 0; index < images.length; index += 1) {
      try {
        var prepared = await prepareImage(images[index]);
        insertImage(prepared.src, prepared.alt);
        added += 1;
      } catch (error) {
        showToast(
          error && error.message ? error.message : "That image couldn't be added.",
          true,
        );
      }
    }

    if (added > 0) {
      notifyEditorChanged();
      updateEditorPlaceholder();
      showToast(added === 1 ? "Image added." : added + " images added.");
    }
  }

  async function prepareImage(file) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      throw new Error("Use a PNG, JPEG, WebP, or GIF image.");
    }

    var alt = imageAltFromName(file.name);

    // Small files keep their exact bytes, so photos stay untouched and small
    // GIFs keep animating. Anything larger is re-encoded to keep documents small.
    if (file.size <= IMAGE_PASSTHROUGH_BYTES) {
      return { src: await readImageFile(file), alt: alt };
    }

    var bitmap;
    try {
      bitmap = await decodeImage(file);
    } catch (error) {
      throw new Error("That image couldn't be read.");
    }

    var scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    var width = Math.max(1, Math.round(bitmap.width * scale));
    var height = Math.max(1, Math.round(bitmap.height * scale));

    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) {
      bitmap.close();
    }

    var src = encodeCanvas(canvas, 0.82);

    if (src.length > IMAGE_MAX_DATA_URL) {
      var smaller = document.createElement("canvas");
      smaller.width = Math.max(1, Math.round(width * 0.72));
      smaller.height = Math.max(1, Math.round(height * 0.72));
      smaller.getContext("2d").drawImage(canvas, 0, 0, smaller.width, smaller.height);
      src = encodeCanvas(smaller, 0.7);
    }

    if (src.length > IMAGE_MAX_DATA_URL) {
      throw new Error("That image is too large to embed, even after shrinking.");
    }

    return { src: src, alt: alt };
  }

  function encodeCanvas(canvas, quality) {
    var src = canvas.toDataURL("image/webp", quality);
    if (src.indexOf("data:image/webp") === 0) {
      return src;
    }
    return canvas.toDataURL("image/jpeg", quality);
  }

  function decodeImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).catch(function () {
        return decodeImageElement(file);
      });
    }
    return decodeImageElement(file);
  }

  function decodeImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("That image couldn't be read."));
      };
      image.src = url;
    });
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        if (typeof reader.result === "string" && reader.result.indexOf("data:image/") === 0) {
          resolve(reader.result);
        } else {
          reject(new Error("That image couldn't be read."));
        }
      };
      reader.onerror = function () {
        reject(new Error("That image couldn't be read."));
      };
      reader.readAsDataURL(file);
    });
  }

  function imageAltFromName(name) {
    var base = String(name || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return base.slice(0, 160) || "Image";
  }

  function insertImage(src, alt) {
    focusEditorForCommand();

    var selection = window.getSelection();
    var inEditor =
      selection &&
      selection.rangeCount > 0 &&
      els.editor.contains(selection.getRangeAt(0).startContainer);
    if (!inEditor) {
      focusEditorAtEnd();
    }

    var markup =
      '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '">';
    var inserted = false;
    try {
      inserted = document.execCommand("insertHTML", false, markup);
    } catch (error) {
      inserted = false;
    }

    if (!inserted) {
      insertImageNode(src, alt);
    }
  }

  function insertImageNode(src, alt) {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    var range = selection.getRangeAt(0);
    if (!els.editor.contains(range.startContainer)) {
      return;
    }

    var image = document.createElement("img");
    image.src = src;
    image.alt = alt;
    range.deleteContents();
    range.insertNode(image);
    range.setStartAfter(image);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function handleEditorClick(event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }

    var image = target.closest("img");
    if (!image || !els.editor.contains(image)) {
      closeImageMenu();
      return;
    }

    openImageMenu(image);
  }

  function openImageMenu(image) {
    activeImage = image;
    updateImageMenuChecks();
    els.imageMenu.hidden = false;
    positionImageMenu(image);

    var current =
      els.imageMenu.querySelector('[aria-checked="true"]') ||
      els.imageMenu.querySelector("button");
    if (current) {
      current.focus({ preventScroll: true });
    }
  }

  function positionImageMenu(image) {
    var menu = els.imageMenu;
    var imageRect = image.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var margin = 12;
    var gap = 10;

    var left = Math.min(imageRect.right - menuRect.width, window.innerWidth - menuRect.width - margin);
    left = Math.max(margin, left);

    var top = imageRect.top - menuRect.height - gap;
    if (top < margin) {
      top = Math.min(imageRect.bottom + gap, window.innerHeight - menuRect.height - margin);
      top = Math.max(margin, top);
    }

    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
  }

  function updateImageMenuChecks() {
    if (!activeImage) {
      return;
    }

    els.imageMenu.querySelectorAll("[data-image-align]").forEach(function (button) {
      var align = button.dataset.imageAlign;
      var active =
        align === "block"
          ? !activeImage.classList.contains("wrap-left") &&
            !activeImage.classList.contains("wrap-right")
          : activeImage.classList.contains("wrap-" + align);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
  }

  function handleImageMenuClick(event) {
    var button = event.target.closest("button");
    if (!button || !activeImage) {
      return;
    }

    var image = activeImage;

    if (button.dataset.imageAction === "remove") {
      removeImage(image);
      return;
    }

    var align = button.dataset.imageAlign;
    image.classList.remove("wrap-left", "wrap-right");
    if (align === "left" || align === "right") {
      image.classList.add("wrap-" + align);
    }

    closeImageMenu();
    notifyEditorChanged();
    els.editor.focus({ preventScroll: true });
  }

  function removeImage(image) {
    var parent = image.parentNode;
    var selection = window.getSelection();
    var range = document.createRange();
    range.selectNode(image);
    selection.removeAllRanges();
    selection.addRange(range);

    // Going through the editing command keeps removal on the undo stack.
    var removed = false;
    try {
      removed = document.execCommand("delete", false, null);
    } catch (error) {
      removed = false;
    }
    if (!removed || image.isConnected) {
      image.remove();
    }

    closeImageMenu();
    notifyEditorChanged();
    updateEditorPlaceholder();

    if (!parent || !els.editor.contains(parent)) {
      return;
    }

    var caret = document.createRange();
    caret.selectNodeContents(parent);
    caret.collapse(false);
    selection.removeAllRanges();
    selection.addRange(caret);
    state.lastRange = caret.cloneRange();
    els.editor.focus({ preventScroll: true });
  }

  function closeImageMenu() {
    if (els.imageMenu.hidden) {
      return;
    }
    els.imageMenu.hidden = true;
    activeImage = null;
  }

  function handleDocumentPointer(event) {
    if (els.imageMenu.hidden) {
      return;
    }
    if (els.imageMenu.contains(event.target)) {
      return;
    }
    if (event.target.closest && event.target.closest("#editor img")) {
      return;
    }
    closeImageMenu();
  }

  /* -----------------------------------------------------------------------
     Document menu, export, and delete
     ----------------------------------------------------------------------- */

  function toggleDocumentMenu() {
    if (els.documentMenuButton.disabled) {
      return;
    }

    var willOpen = els.documentMenu.hidden;
    if (!willOpen) {
      closeDocumentMenu(true);
      return;
    }

    els.documentMenu.hidden = false;
    els.documentMenuButton.setAttribute("aria-expanded", "true");
  }

  function closeDocumentMenu(restoreFocus) {
    if (els.documentMenu.hidden) {
      return;
    }
    els.documentMenu.hidden = true;
    els.documentMenuButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      els.documentMenuButton.focus();
    }
  }

  function handleDocumentMenuAction(event) {
    var item = event.target.closest("[data-doc-action]");
    if (!item) {
      return;
    }

    closeDocumentMenu();

    switch (item.dataset.docAction) {
      case "export-html":
        exportHtml();
        els.documentMenuButton.focus();
        break;
      case "export-markdown":
        exportMarkdown();
        els.documentMenuButton.focus();
        break;
      case "export-text":
        exportText();
        els.documentMenuButton.focus();
        break;
      case "delete":
        openDeleteDialog();
        break;
    }
  }

  function exportHtml() {
    if (!state.loaded) {
      return;
    }

    var title = normalizeTitle(els.documentTitle.value);
    var body = els.editor.innerHTML;
    var escapedTitle = escapeHtml(title);
    var exported = [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>" + escapedTitle + "</title>",
      "<style>",
      "body{max-width:720px;margin:8vh auto;padding:0 28px;color:#272a23;",
      "background:#fbf8f1;font-family:Georgia,'Times New Roman',serif;",
      "font-size:18px;line-height:1.8;}",
      "h1{font-size:2.3em;line-height:1.15;letter-spacing:-.03em;margin:0 0 1.1em;}",
      "h2{font-size:1.55em;line-height:1.3;}h3{font-size:1.25em;}",
      "p{margin:0 0 1em;}blockquote{margin:1.4em 0;padding-left:1.2em;",
      "border-left:2px solid #c4512a;font-style:italic;color:#4a4e43;}",
      "pre{padding:16px;background:#f1ece1;border-radius:8px;white-space:pre-wrap;",
      "font-family:ui-monospace,Consolas,monospace;font-size:.8em;}",
      "code{font-family:ui-monospace,Consolas,monospace;font-size:.84em;}",
      "img{display:block;max-width:100%;height:auto;margin:1.6em auto;border-radius:6px;}",
      "img.wrap-left{float:left;max-width:46%;margin:.35em 1.35em 0 0;}",
      "img.wrap-right{float:right;max-width:46%;margin:.35em 0 0 1.35em;}",
      "h2,h3,h4,blockquote,pre{clear:both;}",
      "a{color:#a83f1d;}footer{margin-top:3em;padding-top:1em;border-top:1px solid #ddd6c8;",
      "color:#8c8b7e;font:12px system-ui,sans-serif;}",
      "</style>",
      "</head>",
      "<body>",
      "<article>",
      "<h1>" + escapedTitle + "</h1>",
      body,
      "</article>",
      "<footer>Exported from Grapho</footer>",
      "</body>",
      "</html>",
    ].join("\n");

    downloadFile(slugify(title) + ".html", exported, "text/html;charset=utf-8");
    showToast("HTML download started.");
  }

  function exportText() {
    if (!state.loaded) {
      return;
    }

    var title = normalizeTitle(els.documentTitle.value);
    var text = els.editor.innerText
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    var exported = title + "\n\n" + text + (text ? "\n" : "");
    downloadFile(slugify(title) + ".txt", exported, "text/plain;charset=utf-8");
    showToast("Text download started.");
  }

  /* Markdown comes straight from the editor DOM: the blocks and inline marks
     the editor can produce become their Markdown equivalents, and anything
     else keeps its text so the export is always readable. */
  function exportMarkdown() {
    if (!state.loaded) {
      return;
    }

    var title = normalizeTitle(els.documentTitle.value);
    var body = markdownBlocks(els.editor).trim();
    var exported = "# " + title + "\n" + (body ? "\n" + body + "\n" : "");
    downloadFile(slugify(title) + ".md", exported, "text/markdown;charset=utf-8");
    showToast("Markdown download started.");
  }

  /* Consecutive inline nodes belong to the same paragraph, which is how a
     hand-formatted first line reaches the DOM. */
  function markdownBlocks(parent) {
    var blocks = [];
    var line = "";
    var children = parent.childNodes;

    function flush() {
      var text = line.trim();
      if (text) {
        blocks.push(text);
      }
      line = "";
    }

    for (var i = 0; i < children.length; i += 1) {
      var node = children[i];
      if (!isMarkdownBlock(node)) {
        line += markdownInline(node);
        continue;
      }

      flush();
      var block = markdownBlock(node);
      if (block) {
        blocks.push(block);
      }
    }

    flush();
    return blocks.join("\n\n");
  }

  function isMarkdownBlock(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    var name = node.tagName;
    return (
      name === "P" ||
      name === "DIV" ||
      name === "BLOCKQUOTE" ||
      name === "PRE" ||
      name === "UL" ||
      name === "OL" ||
      name === "HR" ||
      /^H[1-4]$/.test(name)
    );
  }

  function markdownBlock(node) {
    var name = node.tagName;
    if (name === "UL" || name === "OL") {
      return markdownList(node, "");
    }
    if (name === "PRE") {
      return "```\n" + node.textContent.replace(/\s+$/, "") + "\n```";
    }
    if (name === "BLOCKQUOTE") {
      return quoteMarkdown(markdownBlocks(node));
    }
    if (name === "HR") {
      return "---";
    }
    if (/^H[1-4]$/.test(name)) {
      return hashes(Number(name.charAt(1))) + " " + markdownInline(node).trim();
    }

    return markdownInline(node).trim();
  }

  function quoteMarkdown(text) {
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i += 1) {
      lines[i] = lines[i] ? "> " + lines[i] : ">";
    }
    return lines.join("\n");
  }

  function hashes(level) {
    var marks = "";
    for (var i = 0; i < level; i += 1) {
      marks += "#";
    }
    return marks;
  }

  function markdownList(list, indent) {
    var ordered = list.tagName === "OL";
    var lines = [];
    var number = 1;
    var items = list.children;

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (item.tagName !== "LI") {
        continue;
      }

      var marker = "- ";
      if (ordered) {
        marker = number + ". ";
        number += 1;
      }

      var text = "";
      var nested = [];
      var children = item.childNodes;

      for (var j = 0; j < children.length; j += 1) {
        var child = children[j];
        var isList = child.nodeType === Node.ELEMENT_NODE && (child.tagName === "UL" || child.tagName === "OL");
        if (isList) {
          nested.push(child);
        } else {
          text += markdownInline(child);
        }
      }

      var content = text.replace(/\s+/g, " ").trim();
      lines.push(indent + (content ? marker + content : marker.trim()));

      for (var k = 0; k < nested.length; k += 1) {
        lines.push(markdownList(nested[k], indent + spaces(marker.length)));
      }
    }

    return lines.join("\n");
  }

  function spaces(count) {
    var pad = "";
    for (var i = 0; i < count; i += 1) {
      pad += " ";
    }
    return pad;
  }

  function markdownInline(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeMarkdown(node.nodeValue);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    var name = node.tagName;
    if (name === "BR") {
      return "  \n";
    }
    if (name === "IMG") {
      return markdownImage(node);
    }

    var inner = markdownChildren(node);
    if (!inner) {
      return "";
    }

    if (name === "STRONG" || name === "B") {
      return wrapMark(inner, "**");
    }
    if (name === "EM" || name === "I") {
      return wrapMark(inner, "*");
    }
    if (name === "S" || name === "STRIKE" || name === "DEL") {
      return wrapMark(inner, "~~");
    }
    if (name === "U") {
      return wrapMark(inner, "<u>", "</u>");
    }
    if (name === "CODE") {
      return inlineCode(node.textContent);
    }
    if (name === "A") {
      return markdownLink(node, inner);
    }

    return inner;
  }

  function markdownChildren(node) {
    var text = "";
    var children = node.childNodes;

    for (var i = 0; i < children.length; i += 1) {
      text += markdownInline(children[i]);
    }

    return text;
  }

  function wrapMark(inner, open, close) {
    var leading = /^\s*/.exec(inner)[0];
    var trailing = /\s*$/.exec(inner)[0];
    var core = inner.slice(leading.length, inner.length - trailing.length);

    if (!core) {
      return inner;
    }

    return leading + open + core + (close === undefined ? open : close) + trailing;
  }

  function inlineCode(text) {
    var code = String(text).replace(/\s+/g, " ").trim();
    if (!code) {
      return "";
    }
    if (code.indexOf("`") === -1) {
      return "`" + code + "`";
    }
    return "`` " + code + " ``";
  }

  function markdownLink(node, inner) {
    var href = node.getAttribute("href");
    if (!href) {
      return inner;
    }

    var label = inner.trim() || href;
    var target = /[\s()<>]/.test(href) ? "<" + href + ">" : href;
    return "[" + label + "](" + target + ")";
  }

  function markdownImage(node) {
    var src = node.getAttribute("src");
    if (!src) {
      return "";
    }

    var alt = String(node.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
    var target = /[\s()<>]/.test(src) ? "<" + src + ">" : src;
    return "![" + alt + "](" + target + ")";
  }

  function escapeMarkdown(value) {
    return String(value).replace(/([\\`*_[\]])/g, "\\$1");
  }

  function slugify(value) {
    var slug = String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    return (slug || "document").slice(0, 80);
  }

  function downloadFile(filename, content, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function openDeleteDialog() {
    if (!state.loaded || els.deleteDialog.open) {
      return;
    }
    closeDocumentMenu();
    state.deleting = false;
    els.deleteConfirm.disabled = false;
    els.deleteCancel.disabled = false;
    els.deleteConfirm.textContent = "Delete";
    els.deleteDialog.showModal();
    window.requestAnimationFrame(function () {
      els.deleteConfirm.focus();
    });
  }

  function closeDeleteDialog() {
    if (state.deleting) {
      return;
    }
    if (els.deleteDialog.open) {
      els.deleteDialog.close();
    }
  }

  async function deleteDocument() {
    if (!state.loaded || state.deleting) {
      return;
    }

    state.deleting = true;
    els.deleteConfirm.disabled = true;
    els.deleteCancel.disabled = true;
    els.deleteConfirm.textContent = "Deleting…";

    try {
      await request("/api/documents/" + encodeURIComponent(state.documentId), {
        method: "DELETE",
      });
      state.loaded = false;
      state.dirty = false;
      window.clearTimeout(state.saveTimer);
      window.clearTimeout(state.retryTimer);
      window.location.assign("/");
    } catch (error) {
      if (error.status === 404) {
        state.loaded = false;
        window.location.assign("/");
        return;
      }
      state.deleting = false;
      els.deleteConfirm.disabled = false;
      els.deleteCancel.disabled = false;
      els.deleteConfirm.textContent = "Delete";
      showToast(
        error.userMessage || "The document couldn't be deleted. Please try again.",
        true,
      );
    }
  }

  /* -----------------------------------------------------------------------
     Keyboard and paste handling
     ----------------------------------------------------------------------- */

  function handleGlobalKeydown(event) {
    if (event.key === "Escape") {
      if (!els.imageMenu.hidden) {
        event.preventDefault();
        closeImageMenu();
        els.editor.focus({ preventScroll: true });
        return;
      }
      if (!els.documentMenu.hidden) {
        event.preventDefault();
        closeDocumentMenu(true);
      }
      return;
    }

    if (!state.loaded) {
      return;
    }

    var commandKey = event.ctrlKey || event.metaKey;
    if (!commandKey) {
      return;
    }

    if (event.key.toLocaleLowerCase() === "s") {
      event.preventDefault();
      if (!els.linkDialog.open && !els.deleteDialog.open) {
        saveNow();
      }
      return;
    }

    if (event.key.toLocaleLowerCase() === "k") {
      var hasDialog =
        els.linkDialog.open ||
        els.deleteDialog.open ||
        document.querySelector("dialog[open]");
      if (!hasDialog) {
        event.preventDefault();
        openLinkDialog();
      }
    }
  }

  function handlePaste(event) {
    if (!state.loaded) {
      return;
    }

    var clipboard = event.clipboardData;
    var images = clipboardImages(clipboard);
    if (images.length) {
      event.preventDefault();
      addImages(images);
      return;
    }

    event.preventDefault();
    var plainText = clipboard ? clipboard.getData("text/plain") : "";
    if (!plainText) {
      if (clipboard && clipboard.files && clipboard.files.length > 0) {
        showToast("Only image files can be pasted into a document.", true);
      }
      return;
    }

    var inserted = false;
    try {
      inserted = document.execCommand("insertText", false, plainText);
    } catch (error) {
      inserted = false;
    }

    if (inserted) {
      notifyEditorChanged();
      updateEditorPlaceholder();
    }
  }

  function handleDrop(event) {
    if (!state.loaded) {
      return;
    }

    event.preventDefault();

    var images = imageFilesFrom(event.dataTransfer && event.dataTransfer.files);
    if (!images.length) {
      showToast("Only image files can be dropped into a document.", true);
      return;
    }

    var range = dropRange(event.clientX, event.clientY);
    if (range) {
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      state.lastRange = range.cloneRange();
    }

    addImages(images);
  }

  function dropRange(x, y) {
    var range = null;
    try {
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(x, y);
      } else if (document.caretPositionFromPoint) {
        var position = document.caretPositionFromPoint(x, y);
        if (position) {
          range = document.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
        }
      }
    } catch (error) {
      range = null;
    }

    return range && els.editor.contains(range.startContainer) ? range : null;
  }

  /* -----------------------------------------------------------------------
     Network and small utilities
     ----------------------------------------------------------------------- */

  async function request(path, options) {
    var fetchOptions = Object.assign({}, options || {});
    fetchOptions.headers = {
      Accept: "application/json",
    };

    if (fetchOptions.body && typeof fetchOptions.body !== "string") {
      fetchOptions.headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(fetchOptions.body);
    }

    var response;
    try {
      response = await fetch(path, fetchOptions);
    } catch (networkError) {
      var offline = new Error("Network request failed");
      offline.status = 0;
      offline.userMessage =
        "Couldn't reach Grapho. Check that the server is still running.";
      throw offline;
    }

    if (!response.ok) {
      var message =
        response.status === 404
          ? "That document no longer exists."
          : "The request couldn't be completed.";
      try {
        var payload = await response.json();
        if (payload && payload.error) {
          message = payload.error;
        }
      } catch (parseError) {
        // Keep the friendly fallback when the server sends no JSON.
      }
      var requestError = new Error(message);
      requestError.status = response.status;
      requestError.userMessage = message;
      throw requestError;
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  function showToast(message, isError) {
    window.clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle("is-error", Boolean(isError));
    els.toast.classList.remove("is-visible");

    void els.toast.offsetWidth;
    els.toast.classList.add("is-visible");

    state.toastTimer = window.setTimeout(function () {
      els.toast.classList.remove("is-visible");
    }, isError ? 5000 : 3200);
  }
})();
