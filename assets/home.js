(function () {
  "use strict";

  var state = {
    documents: [],
    query: "",
    view: "list",
    sort: "modified",
    creating: false,
    busy: false,
    pending: null,
    returnFocus: null,
    toastTimer: null,
  };

  var VIEW_KEY = "grapho-library-view";
  var SORT_KEY = "grapho-library-sort";
  var VIEWS = ["list", "grid"];
  var SORTS = ["modified", "created", "title"];
  var SORT_LABELS = {
    modified: "last modified",
    created: "date created",
    title: "title",
  };

  var dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  var dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  var yearDateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  var relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });

  var els = {};

  var ICON_RENAME =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 20 4.2-1L19 8.2 15.8 5 5 15.8 4 20Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m13.8 7 3.2 3.2" stroke="currentColor" stroke-width="1.6"/></svg>';
  var ICON_DELETE =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V4.8h6V7M7 7l.8 12.2h8.4L17 7M10 11v4.5M14 11v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_GRID =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.6" y="3.6" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/></svg>';
  var ICON_LIST =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 18L20 18L20 15.325L9 15.325ZM4 8.675L7 8.675L7 6L4 6ZM4 13.35L7 13.35L7 10.675L4 10.675ZM4 18L7 18L7 15.325L4 15.325ZM9 13.35L20 13.35L20 10.675L9 10.675ZM9 8.675L20 8.675L20 6L9 6ZM4 20Q3.175 20 2.588 19.413A1.93 1.93 0 0 1 2 18L2 6Q2 5.175 2.588 4.588A1.93 1.93 0 0 1 4 4L20 4Q20.824 4 21.413 4.588Q22 5.175 22 6L22 18Q22 18.824 21.413 19.413A1.93 1.93 0 0 1 20 20Z" fill="currentColor"/></svg>';

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.documents = document.getElementById("documents");
    els.searchDocuments = document.getElementById("searchDocuments");
    els.libraryMessage = document.getElementById("libraryMessage");
    els.libraryMessageText = document.getElementById("libraryMessageText");
    els.retryLoad = document.getElementById("retryLoad");
    els.libraryToolbar = document.getElementById("libraryToolbar");
    els.sortColumnLabel = document.getElementById("sortColumnLabel");
    els.viewToggle = document.getElementById("viewToggle");
    els.sortButton = document.getElementById("sortButton");
    els.sortMenu = document.getElementById("sortMenu");
    els.libraryMenuButton = document.getElementById("libraryMenuButton");
    els.libraryMenu = document.getElementById("libraryMenu");
    els.emptyState = document.getElementById("emptyState");
    els.emptyTitle = document.getElementById("emptyTitle");
    els.emptyText = document.getElementById("emptyText");
    els.emptyActions = document.getElementById("emptyActions");
    els.emptyClearSearch = document.getElementById("emptyClearSearch");
    els.newDocument = document.getElementById("newDocument");
    els.cardTemplate = document.getElementById("documentCardTemplate");
    els.actionDialog = document.getElementById("actionDialog");
    els.actionForm = document.getElementById("actionForm");
    els.actionTitle = document.getElementById("actionTitle");
    els.actionDescription = document.getElementById("actionDescription");
    els.actionIcon = document.getElementById("actionIcon");
    els.renameField = document.getElementById("renameField");
    els.renameInput = document.getElementById("renameInput");
    els.actionCancel = document.getElementById("actionCancel");
    els.actionConfirm = document.getElementById("actionConfirm");
    els.toast = document.getElementById("toast");

    state.view = storedChoice(VIEW_KEY, VIEWS, "list");
    state.sort = storedChoice(SORT_KEY, SORTS, "modified");
    applyView();
    syncSortMenu();
    bindStaticEvents();
    loadDocuments();
  }

  function storedChoice(key, allowed, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return allowed.indexOf(value) === -1 ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function rememberChoice(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // A blocked storage area should never break the library controls.
    }
  }

  function bindStaticEvents() {
    els.newDocument.addEventListener("click", createDocument);

    els.searchDocuments.addEventListener("input", function () {
      state.query = els.searchDocuments.value.trim();
      renderDocuments();
    });

    els.searchDocuments.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && els.searchDocuments.value) {
        event.preventDefault();
        els.searchDocuments.value = "";
        state.query = "";
        renderDocuments();
      }
    });

    els.emptyClearSearch.addEventListener("click", clearSearch);
    els.retryLoad.addEventListener("click", function () {
      loadDocuments();
    });

    els.viewToggle.addEventListener("click", toggleView);

    els.sortButton.addEventListener("click", function () {
      if (els.sortMenu.hidden) {
        openSortMenu();
      } else {
        closeSortMenu();
      }
    });

    els.sortMenu.addEventListener("click", function (event) {
      var option = event.target.closest("[data-sort]");
      if (option) {
        chooseSort(option.getAttribute("data-sort"));
      }
    });

    els.libraryMenuButton.addEventListener("click", function () {
      if (els.libraryMenu.hidden) {
        openLibraryMenu();
      } else {
        closeLibraryMenu();
      }
    });

    els.actionCancel.addEventListener("click", closeActionDialog);
    els.actionConfirm.addEventListener("click", confirmAction);
    els.actionForm.addEventListener("submit", function (event) {
      event.preventDefault();
      confirmAction();
    });

    els.actionDialog.addEventListener("click", function (event) {
      if (event.target === els.actionDialog) {
        closeActionDialog();
      }
    });

    els.actionDialog.addEventListener("close", function () {
      var returnFocus = state.returnFocus;
      state.pending = null;
      state.returnFocus = null;
      els.actionConfirm.disabled = false;
      if (returnFocus && returnFocus.isConnected) {
        returnFocus.focus();
      }
    });

    document.addEventListener("click", function (event) {
      if (!event.target.closest(".card-menu-wrap")) {
        closeCardMenus();
      }
      if (!els.sortMenu.closest(".menu-wrap").contains(event.target)) {
        closeSortMenu();
      }
      if (!els.libraryMenu.closest(".menu-wrap").contains(event.target)) {
        closeLibraryMenu();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        var openMenu = document.querySelector(".card-menu:not([hidden])");
        if (openMenu) {
          var wrap = openMenu.closest(".card-menu-wrap");
          closeCardMenus();
          var trigger = wrap && wrap.querySelector(".card-menu-button");
          if (trigger) {
            trigger.focus();
          }
          return;
        }

        if (!els.libraryMenu.hidden) {
          closeLibraryMenu();
          els.libraryMenuButton.focus();
          return;
        }

        if (!els.sortMenu.hidden) {
          closeSortMenu();
          els.sortButton.focus();
        }
        return;
      }

      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !isTypingTarget(event.target) &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        els.searchDocuments.focus();
      }
    });
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    return Boolean(
      target.closest("input, textarea, select, [contenteditable='true']"),
    );
  }

  async function loadDocuments() {
    if (state.busy) {
      return;
    }

    state.busy = true;
    els.documents.setAttribute("aria-busy", "true");
    els.libraryMessage.hidden = true;
    els.retryLoad.hidden = true;
    els.retryLoad.disabled = true;
    els.searchDocuments.disabled = true;

    try {
      var payload = await request("/api/documents");
      state.documents = Array.isArray(payload.documents) ? payload.documents : [];
      applySort();
      renderDocuments();
    } catch (error) {
      showLoadError(error);
    } finally {
      state.busy = false;
      els.documents.setAttribute("aria-busy", "false");
      els.searchDocuments.disabled = false;
    }
  }

  function showLoadError(error) {
    els.documents.replaceChildren();
    els.documents.hidden = true;
    els.libraryToolbar.hidden = true;
    els.emptyState.hidden = true;
    els.libraryMessage.hidden = false;
    els.libraryMessageText.textContent =
      error && error.userMessage
        ? error.userMessage
        : "Your library couldn't be opened. Check that the server is still running.";
    els.retryLoad.hidden = false;
    els.retryLoad.disabled = false;
  }

  function renderDocuments() {
    var query = state.query.toLocaleLowerCase();
    var visible = state.documents.filter(function (document) {
      if (!query) {
        return true;
      }
      return (
        document.title.toLocaleLowerCase().includes(query) ||
        document.excerpt.toLocaleLowerCase().includes(query)
      );
    });

    els.libraryToolbar.hidden = state.documents.length === 0;

    if (state.documents.length === 0) {
      els.documents.replaceChildren();
      els.documents.hidden = true;
      showEmptyState(false);
      return;
    }

    if (visible.length === 0) {
      els.documents.replaceChildren();
      els.documents.hidden = true;
      showEmptyState(true);
      return;
    }

    els.emptyState.hidden = true;
    els.documents.hidden = false;

    var fragment = document.createDocumentFragment();
    visible.forEach(function (document) {
      fragment.appendChild(createDocumentCard(document));
    });
    els.documents.replaceChildren(fragment);
  }

  function showEmptyState(isSearchEmpty) {
    els.emptyState.hidden = false;

    if (isSearchEmpty) {
      els.emptyTitle.textContent = "Nothing matches that search";
      els.emptyText.textContent =
        "Try a different word, or clear the search to see everything.";
      els.emptyText.hidden = false;
      els.emptyActions.hidden = false;
    } else {
      els.emptyTitle.textContent = "No documents yet";
      els.emptyText.hidden = true;
      els.emptyActions.hidden = true;
    }
  }

  function createDocumentCard(document) {
    var fragment = els.cardTemplate.content.cloneNode(true);
    var card = fragment.querySelector(".document-card");
    var link = fragment.querySelector(".document-card-link");
    var title = fragment.querySelector(".document-card-title");
    var excerpt = fragment.querySelector(".document-excerpt");
    var edited = fragment.querySelector(".document-edited");
    var menuWrap = fragment.querySelector(".card-menu-wrap");
    var menuButton = fragment.querySelector(".card-menu-button");
    var menu = fragment.querySelector(".card-menu");
    var openItem = fragment.querySelector(".card-open");
    var renameItem = fragment.querySelector(".card-rename");
    var deleteItem = fragment.querySelector(".card-delete");

    card.dataset.documentId = document.id;
    link.href = "/doc/" + encodeURIComponent(document.id);
    link.setAttribute("aria-label", "Open " + document.title);

    title.textContent = document.title;

    if (document.excerpt) {
      excerpt.textContent = document.excerpt;
    } else {
      excerpt.textContent = "Empty document";
      excerpt.classList.add("is-empty");
    }

    var updated = new Date(document.updated_at);
    var fullDate = dateTimeFormatter.format(updated);
    edited.textContent =
      state.view === "grid"
        ? "Edited " + relativeTime(document.updated_at)
        : dateFormatter.format(updated);
    edited.title = "Edited " + fullDate;

    openItem.href = link.href;

    menuButton.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var willOpen = menu.hidden;
      closeCardMenus();
      if (willOpen) {
        menu.hidden = false;
        menuButton.setAttribute("aria-expanded", "true");
      }
    });

    menu.addEventListener("click", function () {
      closeCardMenus();
    });

    renameItem.addEventListener("click", function () {
      openRenameDialog(document);
    });

    deleteItem.addEventListener("click", function () {
      openDeleteDialog(document);
    });

    card.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.hidden) {
        event.stopPropagation();
        closeCardMenus();
        menuButton.focus();
      }
    });

    // Keep the menu in the tab order, but make sure it cannot be reached while
    // it is visually hidden.
    menu.querySelectorAll("a, button").forEach(function (item) {
      item.tabIndex = -1;
    });
    menuButton.addEventListener("click", function () {
      if (!menu.hidden) {
        menu.querySelectorAll("a, button").forEach(function (item) {
          item.tabIndex = 0;
        });
      } else {
        menu.querySelectorAll("a, button").forEach(function (item) {
          item.tabIndex = -1;
        });
      }
    });

    return fragment;
  }

  function closeCardMenus() {
    document.querySelectorAll(".card-menu").forEach(function (menu) {
      if (!menu.hidden) {
        menu.hidden = true;
        var button = menu.parentElement.querySelector(".card-menu-button");
        if (button) {
          button.setAttribute("aria-expanded", "false");
        }
      }
    });
  }

  async function createDocument() {
    if (state.creating) {
      return;
    }

    state.creating = true;
    setCreatingState(true);

    try {
      var document = await request("/api/documents", { method: "POST" });
      window.location.assign(
        "/doc/" + encodeURIComponent(document.id) + "?new=1",
      );
    } catch (error) {
      state.creating = false;
      setCreatingState(false);
      showToast(
        error.userMessage ||
          "The document couldn't be created. Please try again.",
        true,
      );
    }
  }

  function setCreatingState(isCreating) {
    els.newDocument.disabled = isCreating;
  }

  function openRenameDialog(document) {
    state.pending = { type: "rename", document: document };
    state.returnFocus = cardMenuButton(document.id);
    els.actionTitle.textContent = "Rename document";
    els.actionDescription.textContent =
      "Give this document a name you'll recognize later.";
    els.actionIcon.innerHTML = ICON_RENAME;
    els.actionIcon.classList.remove("modal-icon-danger");
    els.renameField.hidden = false;
    els.renameInput.value = document.title;
    els.actionConfirm.textContent = "Save";
    els.actionConfirm.className = "button button-primary";
    els.actionConfirm.disabled = false;

    if (!els.actionDialog.open) {
      els.actionDialog.showModal();
    }
    window.requestAnimationFrame(function () {
      els.renameInput.focus();
      els.renameInput.select();
    });
  }

  function openDeleteDialog(document) {
    state.pending = { type: "delete", document: document };
    state.returnFocus = cardMenuButton(document.id);
    els.actionTitle.textContent = "Delete this document?";
    els.actionDescription.textContent =
      "“" +
      document.title +
      "” will be removed from your library. It can't be undone.";
    els.actionIcon.innerHTML = ICON_DELETE;
    els.actionIcon.classList.add("modal-icon-danger");
    els.renameField.hidden = true;
    els.actionConfirm.textContent = "Delete";
    els.actionConfirm.className = "button button-danger";
    els.actionConfirm.disabled = false;

    if (!els.actionDialog.open) {
      els.actionDialog.showModal();
    }
    window.requestAnimationFrame(function () {
      els.actionConfirm.focus();
    });
  }

  function closeActionDialog() {
    if (els.actionDialog.open) {
      els.actionDialog.close();
    }
  }

  async function confirmAction() {
    var pending = state.pending;
    if (!pending || els.actionConfirm.disabled) {
      return;
    }

    var isRename = pending.type === "rename";
    var confirmLabel = els.actionConfirm.textContent;
    els.actionConfirm.disabled = true;
    els.actionConfirm.textContent = isRename ? "Saving…" : "Deleting…";

    try {
      if (isRename) {
        var newTitle = els.renameInput.value.trim() || "Untitled document";
        if (newTitle === pending.document.title) {
          closeActionDialog();
          return;
        }

        var updated = await request(
          "/api/documents/" + encodeURIComponent(pending.document.id),
          {
            method: "PUT",
            body: { title: newTitle },
          },
        );

        state.documents = state.documents.map(function (document) {
          if (document.id !== pending.document.id) {
            return document;
          }
          return {
            id: document.id,
            title: updated.title,
            excerpt: document.excerpt,
            word_count: document.word_count,
            created_at: document.created_at,
            updated_at: updated.updated_at,
          };
        });
        applySort();
        renderDocuments();
        state.returnFocus = null;
        closeActionDialog();
        showToast("Document renamed.");
        focusCard(pending.document.id);
      } else {
        await request(
          "/api/documents/" + encodeURIComponent(pending.document.id),
          { method: "DELETE" },
        );
        state.documents = state.documents.filter(function (document) {
          return document.id !== pending.document.id;
        });
        renderDocuments();
        state.returnFocus = null;
        closeActionDialog();
        showToast("“" + pending.document.title + "” was deleted.");
        if (!els.searchDocuments.disabled) {
          els.searchDocuments.focus();
        }
      }
    } catch (error) {
      els.actionConfirm.disabled = false;
      els.actionConfirm.textContent = confirmLabel;
      showToast(
        error.userMessage || "That change couldn't be saved. Please try again.",
        true,
      );
    }
  }

  function focusCard(id) {
    window.requestAnimationFrame(function () {
      var card = els.documents.querySelector(
        '[data-document-id="' + id + '"]',
      );
      var link = card && card.querySelector(".document-card-link");
      if (link) {
        link.focus();
      }
    });
  }

  function cardMenuButton(id) {
    var card = els.documents.querySelector(
      '[data-document-id="' + id + '"]',
    );
    return card ? card.querySelector(".card-menu-button") : null;
  }

  function applySort() {
    state.documents.sort(compareDocuments);
  }

  function compareDocuments(left, right) {
    if (state.sort === "title") {
      return (
        left.title.localeCompare(right.title) ||
        right.updated_at - left.updated_at
      );
    }

    if (state.sort === "created") {
      return (
        right.created_at - left.created_at ||
        left.title.localeCompare(right.title)
      );
    }

    return (
      right.updated_at - left.updated_at || left.title.localeCompare(right.title)
    );
  }

  function toggleView() {
    state.view = state.view === "grid" ? "list" : "grid";
    rememberChoice(VIEW_KEY, state.view);
    applyView();
    renderDocuments();
  }

  function applyView() {
    var isGrid = state.view === "grid";
    els.documents.classList.toggle("is-grid", isGrid);
    els.documents.classList.toggle("is-list", !isGrid);
    els.sortColumnLabel.hidden = isGrid;

    var label = isGrid ? "Switch to list view" : "Switch to grid view";
    els.viewToggle.innerHTML = isGrid ? ICON_LIST : ICON_GRID;
    els.viewToggle.setAttribute("aria-label", label);
    els.viewToggle.setAttribute("title", label);
  }

  function openSortMenu() {
    closeCardMenus();
    closeLibraryMenu();
    els.sortMenu.hidden = false;
    els.sortButton.setAttribute("aria-expanded", "true");
  }

  function closeSortMenu() {
    if (els.sortMenu.hidden) {
      return;
    }
    els.sortMenu.hidden = true;
    els.sortButton.setAttribute("aria-expanded", "false");
  }

  function openLibraryMenu() {
    closeCardMenus();
    closeSortMenu();
    els.libraryMenu.hidden = false;
    els.libraryMenuButton.setAttribute("aria-expanded", "true");
  }

  function closeLibraryMenu() {
    if (els.libraryMenu.hidden) {
      return;
    }
    els.libraryMenu.hidden = true;
    els.libraryMenuButton.setAttribute("aria-expanded", "false");
  }

  function chooseSort(sort) {
    closeSortMenu();
    els.sortButton.focus();
    if (state.sort === sort) {
      return;
    }
    state.sort = sort;
    rememberChoice(SORT_KEY, sort);
    syncSortMenu();
    applySort();
    renderDocuments();
  }

  function syncSortMenu() {
    els.sortMenu.querySelectorAll("[data-sort]").forEach(function (option) {
      option.setAttribute(
        "aria-checked",
        option.getAttribute("data-sort") === state.sort ? "true" : "false",
      );
    });

    var label = "Sort by " + SORT_LABELS[state.sort];
    els.sortButton.setAttribute("aria-label", label);
    els.sortButton.setAttribute("title", label);
  }

  function clearSearch() {
    els.searchDocuments.value = "";
    state.query = "";
    renderDocuments();
    els.searchDocuments.focus();
  }

  function relativeTime(timestamp) {
    var now = Date.now();
    var difference = Math.max(0, now - timestamp);
    var seconds = Math.floor(difference / 1000);

    if (seconds < 45) {
      return "just now";
    }

    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return relativeFormatter.format(-Math.max(1, minutes), "minute");
    }

    var hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return relativeFormatter.format(-Math.max(1, hours), "hour");
    }

    var days = Math.floor(hours / 24);
    if (days < 7) {
      return relativeFormatter.format(-days, "day");
    }

    var date = new Date(timestamp);
    if (date.getFullYear() === new Date().getFullYear()) {
      return yearDateFormatter.format(date);
    }
    return dateFormatter.format(date);
  }

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

    // Restart the entrance transition even when two messages arrive close
    // together.
    void els.toast.offsetWidth;
    els.toast.classList.add("is-visible");

    state.toastTimer = window.setTimeout(function () {
      els.toast.classList.remove("is-visible");
    }, isError ? 5000 : 3200);
  }
})();
