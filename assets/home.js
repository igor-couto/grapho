import {
  extensionEnabled,
  loadExtensions,
  onExtensionsChange,
  refreshExtensions,
  setExtensionEnabled,
} from "./extensions.js";

(function () {
  "use strict";

  var state = {
    documents: [],
    cards: new Map(),
    previewObserver: null,
    query: "",
    returnDocument: null,
    searchTimer: null,
    searchRequest: null,
    searchResults: null,
    searchError: "",
    view: "list",
    sort: "modified",
    loaded: false,
    canChooseDocumentType: false,
    duplicating: new Set(),
    converting: new Set(),
    busy: false,
    pending: null,
    returnFocus: null,
    deletedLoad: 0,
    restoring: new Set(),
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
  var ICON_GRID =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.6" y="3.6" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.6" stroke="currentColor" stroke-width="1.6"/></svg>';
  var ICON_LIST =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 18L20 18L20 15.325L9 15.325ZM4 8.675L7 8.675L7 6L4 6ZM4 13.35L7 13.35L7 10.675L4 10.675ZM4 18L7 18L7 15.325L4 15.325ZM9 13.35L20 13.35L20 10.675L9 10.675ZM9 8.675L20 8.675L20 6L9 6ZM4 20Q3.175 20 2.588 19.413A1.93 1.93 0 0 1 2 18L2 6Q2 5.175 2.588 4.588A1.93 1.93 0 0 1 4 4L20 4Q20.824 4 21.413 4.588Q22 5.175 22 6L22 18Q22 18.824 21.413 19.413A1.93 1.93 0 0 1 20 20Z" fill="currentColor"/></svg>';

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.documents = document.getElementById("documents");
    els.librarySpace = document.getElementById("librarySpace");
    els.newDocument = document.getElementById("newDocument");
    els.newDocumentDialog = document.getElementById("newDocumentDialog");
    els.documentTypeOptions = document.getElementById("documentTypeOptions");
    els.extensionDocumentTypes = els.documentTypeOptions.querySelectorAll("[data-document-extension]");
    els.extensionsButton = document.getElementById("extensionsButton");
    els.extensionsDialog = document.getElementById("extensionsDialog");
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
    els.cardTemplate = document.getElementById("documentCardTemplate");
    els.actionDialog = document.getElementById("actionDialog");
    els.actionForm = document.getElementById("actionForm");
    els.actionTitle = document.getElementById("actionTitle");
    els.actionDescription = document.getElementById("actionDescription");
    els.actionIcon = document.getElementById("actionIcon");
    els.renameField = document.getElementById("renameField");
    els.renameInput = document.getElementById("renameInput");
    els.moveField = document.getElementById("moveField");
    els.moveSpace = document.getElementById("moveSpace");
    els.moveError = document.getElementById("moveError");
    els.actionCancel = document.getElementById("actionCancel");
    els.actionConfirm = document.getElementById("actionConfirm");
    els.recentlyDeletedButton = document.getElementById("recentlyDeletedButton");
    els.recentlyDeletedDialog = document.getElementById("recentlyDeletedDialog");
    els.recentlyDeletedList = document.getElementById("recentlyDeletedList");
    els.recentlyDeletedStatus = document.getElementById("recentlyDeletedStatus");
    els.recentlyDeletedClose = document.getElementById("recentlyDeletedClose");
    els.recentlyDeletedRetry = document.getElementById("recentlyDeletedRetry");
    els.recentlyDeletedRow = document.getElementById("recentlyDeletedRow");
    els.signOut = document.getElementById("signOut");
    els.signOutRule = document.getElementById("signOutRule");
    els.toast = document.getElementById("toast");

    state.previewObserver =
      "IntersectionObserver" in window
        ? new IntersectionObserver(previewSeen, { rootMargin: "600px 0px" })
        : null;
    state.view = storedChoice(VIEW_KEY, VIEWS, "list");
    state.sort = storedChoice(SORT_KEY, SORTS, "modified");
    var params = new URLSearchParams(window.location.search);
    els.searchDocuments.value = params.get("q") || "";
    state.returnDocument = params.get("from");
    applyView();
    syncSortMenu();
    bindStaticEvents();
    syncExtensions();
    onExtensionsChange(syncExtensions);
    loadExtensions();
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
    els.newDocument.addEventListener("click", function (event) {
      if (!state.canChooseDocumentType) return;
      event.preventDefault();
      els.newDocumentDialog.showModal();
    });
    els.documentTypeOptions.addEventListener("click", function (event) {
      if (event.target.closest("a")) els.newDocumentDialog.close();
    });
    els.newDocumentDialog.addEventListener("click", function (event) {
      if (event.target === els.newDocumentDialog) els.newDocumentDialog.close();
    });
    els.newDocumentDialog.addEventListener("close", function () {
      els.newDocument.focus();
    });

    els.searchDocuments.addEventListener("input", updateSearch);
    els.librarySpace.addEventListener("change", function () {
      syncSearchUrl();
      var url = new URL(window.location.href);
      var space = els.librarySpace.value;
      if (space) url.searchParams.set("space", space);
      else url.searchParams.delete("space");
      url.searchParams.delete("from");
      window.history.pushState(null, "", url);
      readLibraryLocation();
      updateSearch(true);
    });
    window.addEventListener("popstate", function () {
      if (state.loaded) {
        readLibraryLocation();
        updateSearch(true);
      }
    });

    els.searchDocuments.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && els.searchDocuments.value) {
        event.preventDefault();
        clearSearch();
      }
    });

    els.emptyClearSearch.addEventListener("click", clearSearch);
    els.retryLoad.addEventListener("click", function () {
      if (state.loaded) {
        updateSearch();
      } else {
        loadDocuments();
      }
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

    els.signOut.addEventListener("click", signOut);

    els.extensionsButton.addEventListener("click", function () {
      closeLibraryMenu();
      els.extensionsDialog.showModal();
      // Another computer may have changed the switches since this page loaded.
      refreshExtensions();
    });
    els.extensionsDialog.addEventListener("change", function (event) {
      var option = event.target;
      if (!option.matches("[data-extension]")) return;
      var saving = setExtensionEnabled(
        option.dataset.extension,
        option.checked,
      );
      syncExtensions();
      option.disabled = true;
      saving
        .catch(function (error) {
          showToast(
            error.userMessage || "That extension couldn't be changed. Try again.",
            true,
          );
        })
        .finally(function () {
          option.disabled = false;
        });
    });
    els.extensionsDialog.addEventListener("close", function () {
      els.libraryMenuButton.focus();
    });
    els.extensionsDialog.addEventListener("click", function (event) {
      if (event.target === els.extensionsDialog) els.extensionsDialog.close();
    });

    els.recentlyDeletedButton.addEventListener("click", function () {
      closeLibraryMenu();
      els.recentlyDeletedDialog.showModal();
      loadRecentlyDeleted();
    });
    els.recentlyDeletedRetry.addEventListener("click", loadRecentlyDeleted);
    els.recentlyDeletedDialog.addEventListener("close", function () {
      els.libraryMenuButton.focus();
    });
    els.recentlyDeletedDialog.addEventListener("click", function (event) {
      if (event.target === els.recentlyDeletedDialog) {
        els.recentlyDeletedDialog.close();
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

    els.actionDialog.addEventListener("cancel", function (event) {
      if (state.pending?.type === "move" && els.actionConfirm.disabled) {
        event.preventDefault();
      }
    });

    els.actionDialog.addEventListener("close", function () {
      var returnFocus = state.returnFocus;
      state.pending = null;
      state.returnFocus = null;
      els.moveError.hidden = true;
      els.actionConfirm.disabled = false;
      els.actionCancel.disabled = false;
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
    showLibrarySkeleton();

    try {
      var payload = await request("/api/documents");
      state.documents = Array.isArray(payload.documents) ? payload.documents : [];
      state.unavailableSpaces = new Set();
      state.spaces = new Map((payload.spaces || []).map(function (space) {
        var unavailable = space.available === false;
        if (unavailable) state.unavailableSpaces.add(space.id);
        els.librarySpace.add(new Option(space.name + (unavailable ? " (unavailable)" : ""), space.id));
        return [space.id, space.name];
      }));
      readLibraryLocation();
      els.librarySpace.disabled = false;
      state.loaded = true;
      els.signOut.hidden = !payload.auth_required;
      els.signOutRule.hidden = !payload.auth_required;
      applySort();
      updateSearch(true);
    } catch (error) {
      showLoadError(error);
    } finally {
      state.busy = false;
      if (!state.loaded) {
        els.documents.setAttribute("aria-busy", "false");
      }
      els.searchDocuments.disabled = state.loaded && state.unavailableSpaces.has(state.space);
    }
  }

  function readLibraryLocation() {
    var params = new URLSearchParams(window.location.search);
    var space = params.get("space");
    state.space = space === "general" || state.spaces.has(space) ? space : "";
    state.returnDocument = params.get("from");
    els.searchDocuments.value = params.get("q") || "";
    els.librarySpace.value = state.space;
    var unavailable = state.unavailableSpaces.has(state.space);
    els.searchDocuments.disabled = unavailable;
    els.newDocument.hidden = unavailable;
    var spaceQuery = state.space ? "?space=" + encodeURIComponent(state.space) : "";
    els.newDocument.search = spaceQuery;
    els.documentTypeOptions.querySelectorAll("a").forEach(function (option) {
      option.search = spaceQuery;
    });
  }

  function syncExtensions() {
    els.extensionsDialog.querySelectorAll("[data-extension]").forEach(function (option) {
      option.checked = extensionEnabled(option.dataset.extension);
    });
    state.canChooseDocumentType = false;
    els.extensionDocumentTypes.forEach(function (option) {
      option.hidden = !extensionEnabled(option.dataset.documentExtension);
      if (!option.hidden) state.canChooseDocumentType = true;
    });
    if (state.canChooseDocumentType) {
      els.newDocument.setAttribute("aria-haspopup", "dialog");
      els.newDocument.setAttribute("aria-controls", els.newDocumentDialog.id);
    } else {
      els.newDocument.removeAttribute("aria-haspopup");
      els.newDocument.removeAttribute("aria-controls");
      if (els.newDocumentDialog.open) els.newDocumentDialog.close();
    }
    // Convert to board is per-card, and the switch belongs to the server.
    state.cards.forEach(syncCardMenu);
  }

  // The page ships a few placeholder rows so the very first paint is never an
  // empty library; this rebuilds the set to cover the first screen in the
  // current view. It also runs again on a retry, because the placeholders stay
  // in the DOM through the failed load.
  function showLibrarySkeleton() {
    var skeleton = els.documents.querySelector(".document-card-skeleton");
    if (!skeleton) {
      return;
    }

    els.documents.hidden = false;
    els.libraryToolbar.hidden = false;
    els.emptyState.hidden = true;

    var count = skeletonCardCount(skeleton);
    var fragment = document.createDocumentFragment();
    for (var index = 0; index < count; index += 1) {
      fragment.appendChild(skeleton.cloneNode(true));
    }
    els.documents.replaceChildren(fragment);
  }

  // One placeholder per list row, one per grid cell: enough to reach the bottom
  // of the first screen without waiting for the listing to say how many
  // documents there are. The row height and gap come from the placeholder
  // itself, so the count follows the view and the stylesheet.
  function skeletonCardCount(skeleton) {
    var style = window.getComputedStyle(els.documents);
    var room = window.innerHeight - els.documents.getBoundingClientRect().top;
    var height =
      skeleton.getBoundingClientRect().height + (parseFloat(style.rowGap) || 0);
    if (!(room > 0) || !(height > 0)) {
      return 3;
    }

    var perRow = 1;
    if (state.view === "grid") {
      perRow = style.gridTemplateColumns.split(" ").filter(Boolean).length || 1;
    }

    return Math.max(3, Math.ceil(room / height) * perRow);
  }

  function showLoadError(error) {
    // The placeholders stay in the DOM (only the container is hidden) so the
    // retry button has something to show while it waits.
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

  function cancelSearch() {
    window.clearTimeout(state.searchTimer);
    if (state.searchRequest) {
      state.searchRequest.abort();
      state.searchRequest = null;
    }
  }

  function syncSearchUrl() {
    var url = new URL(window.location.href);
    if (state.query !== (url.searchParams.get("q") || "")) {
      if (state.query) url.searchParams.set("q", state.query);
      else url.searchParams.delete("q");
      url.searchParams.delete("from");
      state.returnDocument = null;
      window.history.replaceState(window.history.state, "", url);
    }
  }

  function updateSearch(immediate) {
    if (!state.loaded) {
      return;
    }
    cancelSearch();
    state.query = els.searchDocuments.value.trim();
    state.searchResults = null;
    state.searchError = "";
    renderDocuments();
    if (state.unavailableSpaces.has(state.space)) return;
    if (state.query) {
      state.searchTimer = window.setTimeout(searchDocuments, immediate === true ? 0 : 230);
    } else {
      syncSearchUrl();
    }
  }

  async function searchDocuments() {
    cancelSearch();
    syncSearchUrl();
    var controller = new AbortController();
    state.searchRequest = controller;
    var params = new URLSearchParams({ q: state.query });
    if (state.space) params.set("space", state.space);

    try {
      var payload = await request("/api/documents/search?" + params, {
        signal: controller.signal,
      });
      if (state.searchRequest !== controller) {
        return;
      }
      state.searchResults = payload.matches;
      state.searchError = "";
    } catch (error) {
      if (state.searchRequest !== controller) {
        return;
      }
      state.searchResults = null;
      state.searchError =
        "Couldn't search your documents. " +
        (error.userMessage || "Try again.");
    }
    state.searchRequest = null;
    renderDocuments();
    if (state.searchResults && state.returnDocument) {
      var card = state.cards.get(state.returnDocument);
      if (card && card.element.isConnected && document.activeElement === document.body) {
        card.link.focus({ preventScroll: true });
        card.link.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
      state.returnDocument = null;
    }
  }

  async function refreshAfterChange() {
    if (state.query) {
      await searchDocuments();
    } else {
      renderDocuments();
    }
  }

  function renderDocuments() {
    if (!state.loaded) {
      // A view or sort change arrived before the first listing did; the
      // placeholders stay until the documents arrive.
      return;
    }

    if (state.unavailableSpaces.has(state.space)) {
      els.documents.setAttribute("aria-busy", "false");
      els.documents.hidden = true;
      els.libraryToolbar.hidden = true;
      els.emptyState.hidden = true;
      els.libraryMessage.classList.remove("is-searching");
      els.libraryMessage.hidden = false;
      els.libraryMessageText.textContent =
        "The storage folder for " + state.spaces.get(state.space) +
        " is unavailable. Reconnect the folder, then restart Grapho.";
      els.retryLoad.hidden = true;
      return;
    }

    var searching = Boolean(state.query);
    var waiting = searching && !state.searchResults && !state.searchError;
    els.documents.setAttribute("aria-busy", String(waiting));
    els.libraryMessage.classList.toggle("is-searching", waiting);
    els.libraryMessage.hidden = !waiting && !state.searchError;
    els.libraryMessageText.textContent = waiting ? "Searching…" : state.searchError;
    els.retryLoad.hidden = !state.searchError;
    els.retryLoad.disabled = !state.searchError;
    els.documents.classList.toggle("is-search-results", searching);

    var inSpace = state.space
      ? state.documents.filter(function (document) {
          return (document.space_id || "general") === state.space;
        })
      : state.documents;
    var visible = searching
      ? (state.searchResults || []).slice().sort(compareDocuments)
      : inSpace;
    els.libraryToolbar.hidden = inSpace.length === 0 && visible.length === 0;

    if (!searching && visible.length === 0) {
      if (state.documents.length === 0) forgetCards();
      else state.cards.forEach(stopObservingCard);
      els.documents.replaceChildren();
      els.documents.hidden = true;
      showEmptyState(false);
      return;
    }

    if (visible.length === 0) {
      state.cards.forEach(stopObservingCard);
      els.documents.replaceChildren();
      els.documents.hidden = true;
      if (waiting || state.searchError) {
        els.emptyState.hidden = true;
      } else {
        showEmptyState(true);
      }
      return;
    }

    els.emptyState.hidden = true;
    els.documents.hidden = false;
    closeCardMenus();

    // Cards are kept between renders so filtering by search does not rebuild
    // them (and their previews, which are the expensive part of a card).
    var known = new Set(
      state.documents.concat(visible).map(function (document) {
        return document.id;
      }),
    );
    state.cards.forEach(function (card, id) {
      if (!known.has(id)) {
        stopObservingCard(card);
        state.cards.delete(id);
      }
    });

    var fragment = document.createDocumentFragment();
    visible.forEach(function (document) {
      var card = state.cards.get(document.id);
      if (!card) {
        card = createDocumentCard(document);
        state.cards.set(document.id, card);
      } else {
        syncCard(card, document);
      }
      fragment.appendChild(card.element);
    });
    els.documents.replaceChildren(fragment);

    // Previews are painted only for cards near the viewport, so a large
    // library never lays out hundreds of miniature pages at once.
    state.cards.forEach(function (card) {
      if (state.view === "grid" && card.element.isConnected) {
        observePreview(card);
      } else {
        stopObservingCard(card);
      }
    });
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
    var card = {
      document: document,
      element: fragment.querySelector(".document-card"),
      link: fragment.querySelector(".document-card-link"),
      preview: fragment.querySelector(".document-preview"),
      title: fragment.querySelector(".document-card-title"),
      space: fragment.querySelector(".document-space"),
      excerpt: fragment.querySelector(".document-search-excerpt"),
      edited: fragment.querySelector(".document-edited"),
      previewFilled: false,
    };
    var menuButton = fragment.querySelector(".card-menu-button");
    var menu = fragment.querySelector(".card-menu");
    var openItem = fragment.querySelector(".card-open");
    var renameItem = fragment.querySelector(".card-rename");
    var duplicateItem = fragment.querySelector(".card-duplicate");
    var boardItem = fragment.querySelector(".card-board");
    var moveItem = fragment.querySelector(".card-move");
    var deleteItem = fragment.querySelector(".card-delete");

    card.element.dataset.documentId = document.id;
    card.openItem = openItem;
    card.boardItem = boardItem;
    moveItem.hidden = !state.spaces.size;
    syncCard(card, document);

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
      openRenameDialog(card.document);
    });

    duplicateItem.addEventListener("click", function () {
      duplicateDocument(card.document);
    });
    boardItem.addEventListener("click", function () {
      convertDocument(card.document);
    });
    moveItem.addEventListener("click", function () {
      openMoveDialog(card.document);
    });

    deleteItem.addEventListener("click", function () {
      openDeleteDialog(card.document);
    });

    card.element.addEventListener("keydown", function (event) {
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

    return card;
  }

  function syncCard(card, document) {
    card.document = document;
    syncCardMenu(card);
    card.element.classList.toggle("is-board", Boolean(document.board));
    card.element.classList.toggle("is-drawing", Boolean(document.drawing));
    card.link.href = "/doc/" + encodeURIComponent(document.id);
    var params = new URLSearchParams();
    if (state.space) params.set("space", state.space);
    if (state.query) {
      params.set("q", state.query);
      if (document.body_match) params.set("passage", "1");
    }
    card.link.search = params.toString();
    var spaceName = state.spaces.get(document.space_id) || "General";
    var showSpace = !state.space && state.spaces.size > 0;
    var openLabel = "Open ";
    if (document.board) openLabel += "board ";
    if (document.drawing) openLabel += "drawing ";
    card.link.setAttribute("aria-label", openLabel + document.title + (showSpace ? " in " + spaceName : ""));
    card.title.title = document.title_match ? document.title : "";
    if (document.title_match) {
      showMatch(card.title, document.title_match);
    } else {
      card.title.textContent = document.title;
    }
    if (document.body_match) {
      showMatch(card.excerpt, document.body_match);
      card.link.setAttribute("aria-description", card.excerpt.textContent);
    } else {
      card.excerpt.textContent = "";
      card.link.removeAttribute("aria-description");
    }
    card.excerpt.hidden = !document.body_match;
    card.space.hidden = !showSpace;
    card.space.textContent = spaceName;
    card.openItem.href = card.link.href;

    var updated = new Date(document.updated_at);
    card.edited.textContent =
      state.view === "grid"
        ? "Edited " + relativeTime(document.updated_at)
        : dateFormatter.format(updated);
    card.edited.title = "Edited " + dateTimeFormatter.format(updated);
  }

  // Convert to board belongs to the Boards extension and only makes sense for
  // ordinary documents: a board is already one, and a drawing is its own type.
  function syncCardMenu(card) {
    var document = card.document;
    card.boardItem.hidden = !extensionEnabled("boards") || Boolean(document.board || document.drawing);
  }

  function showMatch(element, excerpt) {
    var mark = document.createElement("mark");
    mark.textContent = excerpt.matched;
    element.replaceChildren(excerpt.before, mark, excerpt.after);
  }

  function previewSeen(entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) {
        return;
      }
      state.previewObserver.unobserve(entry.target);
      var card = state.cards.get(entry.target.dataset.documentId);
      if (card) {
        fillPreview(card);
      }
    });
  }

  function observePreview(card) {
    if (card.previewFilled || state.view !== "grid" || !card.element.isConnected) {
      return;
    }
    if (state.previewObserver) {
      state.previewObserver.observe(card.element);
    } else {
      fillPreview(card);
    }
  }

  function stopObservingCard(card) {
    if (state.previewObserver) {
      state.previewObserver.unobserve(card.element);
    }
  }

  function fillPreview(card) {
    if (card.previewFilled) {
      return;
    }
    card.previewFilled = true;
    // The server builds this markup from the sanitized document: block tags and
    // inline marks only, no attributes, links, or images. It is already safe to
    // paint, and keeping it out of the DOM until the card is near the viewport
    // is what keeps a large library cheap to open.
    card.preview.innerHTML = card.document.preview || "";
  }

  function forgetCards() {
    state.cards.forEach(stopObservingCard);
    state.cards.clear();
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

  // A copy is a brand new document, made by the server and answered with the
  // same summary the listing carries, so the new card can go straight into the
  // library without fetching it again. The copy keeps its source's writing and
  // name plus " (copy)", and gets its own id, file, and timestamps.
  async function duplicateDocument(document) {
    if (state.duplicating.has(document.id)) {
      return;
    }
    state.duplicating.add(document.id);

    try {
      var copy = await request(
        "/api/documents/" + encodeURIComponent(document.id) + "/duplicate",
        { method: "POST" },
      );
      state.documents.push(copy);
      applySort();
      await refreshAfterChange();
      showToast("Document duplicated.");
      focusCard(copy.id);
    } catch (error) {
      showToast(
        error.userMessage ||
          "The document couldn't be duplicated. Please try again.",
        true,
      );
      var menuButton = cardMenuButton(document.id);
      if (menuButton) {
        menuButton.focus();
      }
    } finally {
      state.duplicating.delete(document.id);
    }
  }

  // The server reads the document's Markdown as board source and decides whether
  // a board can show it. Its answer is the card summary, so the card switches to
  // the board glyph and open label in place. A document the server cannot read
  // as a board explains why in the toast and stays a document.
  async function convertDocument(document) {
    if (state.converting.has(document.id)) {
      return;
    }
    state.converting.add(document.id);

    try {
      var converted = await request(
        "/api/documents/" + encodeURIComponent(document.id) + "/board",
        { method: "POST" },
      );
      state.documents = state.documents.map(function (entry) {
        return entry.id === document.id ? converted : entry;
      });
      applySort();
      await refreshAfterChange();
      showToast("Document converted to a board.");
      focusCard(document.id);
    } catch (error) {
      showToast(
        error.userMessage ||
          "The document couldn't be converted to a board.",
        true,
      );
      var menuButton = cardMenuButton(document.id);
      if (menuButton) {
        menuButton.focus();
      }
    } finally {
      state.converting.delete(document.id);
    }
  }

  async function signOut() {
    closeLibraryMenu();
    els.signOut.disabled = true;

    try {
      await request("/api/session", { method: "DELETE" });
      window.location.assign("/login");
    } catch (error) {
      els.signOut.disabled = false;
      showToast(
        error.userMessage || "Couldn't sign out. Please try again.",
        true,
      );
    }
  }

  function openRenameDialog(document) {
    state.pending = { type: "rename", document: document };
    state.returnFocus = cardMenuButton(document.id);
    els.actionTitle.textContent = "Rename document";
    els.actionDescription.textContent =
      "Give this document a name you'll recognize later.";
    els.actionIcon.innerHTML = ICON_RENAME;
    els.actionIcon.hidden = false;
    els.renameField.hidden = false;
    els.moveField.hidden = true;
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
      "” will move to Recently deleted in the library menu.";
    els.actionIcon.innerHTML = "";
    els.actionIcon.hidden = true;
    els.renameField.hidden = true;
    els.moveField.hidden = true;
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

  function openMoveDialog(document) {
    state.pending = { type: "move", document: document };
    state.returnFocus = cardMenuButton(document.id);
    els.actionTitle.textContent = "Move to Space";
    els.actionDescription.textContent = document.title;
    els.actionIcon.hidden = true;
    els.renameField.hidden = true;
    els.moveField.hidden = false;
    els.moveError.hidden = true;
    els.moveSpace.replaceChildren(new Option("General", ""));
    state.spaces.forEach(function (name, id) {
      var unavailable = state.unavailableSpaces.has(id);
      var option = new Option(name + (unavailable ? " (unavailable)" : ""), id);
      option.disabled = unavailable;
      els.moveSpace.add(option);
    });
    els.moveSpace.value = document.space_id || "";
    els.actionConfirm.textContent = "Move";
    els.actionConfirm.className = "button button-primary";
    els.actionConfirm.disabled = false;
    els.actionDialog.showModal();
    els.moveSpace.focus();
  }

  function closeActionDialog() {
    if (els.actionDialog.open && !(state.pending?.type === "move" && els.actionConfirm.disabled)) {
      els.actionDialog.close();
    }
  }

  async function confirmAction() {
    var pending = state.pending;
    if (!pending || els.actionConfirm.disabled) {
      return;
    }

    var confirmLabel = els.actionConfirm.textContent;
    els.actionConfirm.disabled = true;
    els.actionConfirm.textContent = pending.type === "delete" ? "Deleting…" : "Saving…";

    try {
      if (pending.type === "rename") {
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
          return Object.assign({}, document, { title: updated.title, updated_at: updated.updated_at });
        });
        applySort();
        state.returnFocus = null;
        closeActionDialog();
        await refreshAfterChange();
        showToast("Document renamed.");
        focusCard(pending.document.id);
      } else if (pending.type === "move") {
        var destination = els.moveSpace.value || null;
        if (destination === (pending.document.space_id || null)) {
          els.actionDialog.close();
          return;
        }
        els.actionCancel.disabled = true;
        els.moveError.hidden = true;
        var moved = await request(
          "/api/documents/" + encodeURIComponent(pending.document.id) + "/space",
          { method: "PUT", body: { space_id: destination } },
        );
        state.documents = state.documents.map(function (document) {
          return document.id === moved.id ? moved : document;
        });
        state.returnFocus = null;
        els.actionDialog.close();
        await refreshAfterChange();
        showToast("Moved to " + (state.spaces.get(destination) || "General") + ".");
        if (state.space) els.librarySpace.focus();
        else focusCard(moved.id);
      } else {
        await request(
          "/api/documents/" + encodeURIComponent(pending.document.id),
          { method: "DELETE" },
        );
        state.documents = state.documents.filter(function (document) {
          return document.id !== pending.document.id;
        });
        state.returnFocus = null;
        closeActionDialog();
        await refreshAfterChange();
        showToast("Moved to Recently deleted.");
        if (!els.searchDocuments.disabled) {
          els.searchDocuments.focus();
        }
      }
    } catch (error) {
      els.actionConfirm.disabled = false;
      els.actionConfirm.textContent = confirmLabel;
      if (pending.type === "move") {
        els.actionCancel.disabled = false;
        els.moveError.textContent = error.userMessage || "The document couldn't be moved. Try again.";
        els.moveError.hidden = false;
        return;
      }
      showToast(
        error.userMessage || "That change couldn't be saved. Please try again.",
        true,
      );
    }
  }

  function showDeletedStatus(text, isError) {
    els.recentlyDeletedStatus.textContent = text;
    els.recentlyDeletedStatus.classList.toggle("is-error", Boolean(isError));
  }

  async function loadRecentlyDeleted() {
    var load = ++state.deletedLoad;
    els.recentlyDeletedRetry.hidden = true;
    els.recentlyDeletedList.replaceChildren();
    showDeletedStatus("Loading deleted documents…");

    try {
      var payload = await request("/api/documents/deleted");
      if (load !== state.deletedLoad || !els.recentlyDeletedDialog.open) {
        return;
      }
      var deleted = payload.documents.filter(function (document) {
        return !state.space || (document.space_id || "general") === state.space;
      });
      deleted.forEach(function (document) {
        var row = els.recentlyDeletedRow.content.firstElementChild.cloneNode(true);
        row.dataset.documentId = document.id;
        row.querySelector(".deleted-title").textContent = document.title;
        var date = row.querySelector("time");
        var timestamp = new Date(document.deleted_at);
        date.dateTime = timestamp.toISOString();
        date.textContent = "Deleted " + dateTimeFormatter.format(timestamp);

        var button = row.querySelector("button");
        button.setAttribute("aria-label", "Restore " + document.title);
        button.disabled = state.restoring.has(document.id);
        button.addEventListener("click", function () {
          restoreDocument(document.id);
        });
        els.recentlyDeletedList.appendChild(row);
      });
      showDeletedStatus(deleted.length ? "" : "No deleted documents.");
    } catch (error) {
      if (load === state.deletedLoad && els.recentlyDeletedDialog.open) {
        showDeletedStatus("Couldn't load deleted documents.", true);
        els.recentlyDeletedRetry.hidden = false;
      }
    }
  }

  async function restoreDocument(id) {
    if (state.restoring.has(id)) {
      return;
    }
    var selector = '[data-document-id="' + CSS.escape(id) + '"]';
    var row = els.recentlyDeletedList.querySelector(selector);
    var load = state.deletedLoad;
    var restore = row.querySelector("button");
    state.restoring.add(id);
    restore.disabled = true;
    try {
      var restored = await request("/api/documents/" + encodeURIComponent(id) + "/restore", {
        method: "POST",
      });
      state.documents = state.documents.filter(function (document) {
        return document.id !== id;
      });
      state.documents.push(restored);
      applySort();
      await refreshAfterChange();

      var message = "Restored “" + restored.title + "”.";
      if (!els.recentlyDeletedDialog.open) {
        showToast(message);
      } else if (load !== state.deletedLoad) {
        await loadRecentlyDeleted();
      } else {
        var next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        if (!els.recentlyDeletedDialog.contains(document.activeElement)) {
          var nextButton = next && next.querySelector("button:not(:disabled)");
          (nextButton || els.recentlyDeletedClose).focus();
        }
        showDeletedStatus(message);
      }
    } catch (error) {
      var message = error.userMessage || "That document couldn't be restored. Try again.";
      if (els.recentlyDeletedDialog.open) {
        showDeletedStatus(message, true);
        var current = els.recentlyDeletedList.querySelector(selector);
        if (current) {
          current.querySelector("button").disabled = false;
        }
      } else {
        showToast(message, true);
      }
    } finally {
      state.restoring.delete(id);
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
    if (state.loaded) {
      renderDocuments();
    } else {
      showLibrarySkeleton();
    }
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
    updateSearch();
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

  function loginUrl() {
    return (
      "/login?next=" +
      encodeURIComponent(window.location.pathname + window.location.search)
    );
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
      if (fetchOptions.signal && fetchOptions.signal.aborted) {
        throw networkError;
      }
      var offline = new Error("Network request failed");
      offline.userMessage =
        "Couldn't reach Grapho. Check that the server is still running.";
      throw offline;
    }

    fetchOptions.signal?.throwIfAborted();
    if (!response.ok) {
      if (response.status === 401) {
        window.location.assign(loginUrl());
        var authError = new Error("Sign in required");
        authError.userMessage = "Your session ended. Sign in again.";
        throw authError;
      }

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
