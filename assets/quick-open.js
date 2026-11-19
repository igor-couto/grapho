// Ctrl+O opens a search over the library from any page except the password
// gate. The listing is read when the search opens, so the editor, storage,
// version, shortcuts, and not-found pages get the whole library without
// loading it in the background. Filtering stays local: one request per
// opening, none per keystroke.
(function () {
  "use strict";

  var SEARCH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3" stroke="currentColor" stroke-width="1.7"/><path d="m15.5 15.5 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  // How long the keyboard hints stay before fading out; the fade itself lives
  // in app.css so it can respect reduced motion.
  var HINT_TIMEOUT_MS = 3000;

  var relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  var dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  var yearDateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  var state = {
    dialog: null,
    input: null,
    list: null,
    message: null,
    count: null,
    open: false,
    loaded: false,
    loading: false,
    failed: false,
    signIn: false,
    documents: null,
    visible: [],
    options: [],
    selected: 0,
    query: "",
    opener: null,
    requestId: 0,
    hints: null,
    hintTimer: null,
  };

  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("focusin", keepSearchFocused);

  function handleKeydown(event) {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }

    var command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey && event.key.toLocaleLowerCase() === "o") {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) {
        return;
      }
      if (state.open) {
        closeSearch(true);
      } else if (!otherDialogOpen()) {
        openSearch();
      }
      return;
    }

    if (!state.open) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        event.stopPropagation();
        moveSelection(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        event.stopPropagation();
        moveSelection(-1);
        return;
      case "PageDown":
        event.preventDefault();
        event.stopPropagation();
        moveSelection(5);
        return;
      case "PageUp":
        event.preventDefault();
        event.stopPropagation();
        moveSelection(-5);
        return;
      case "Enter":
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          choose(event.shiftKey);
        }
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeSearch(true);
        return;
      case "Tab":
        // The search field is the dialog's only focusable control. Keep focus
        // there instead of walking into the browser's own chrome.
        event.preventDefault();
        event.stopPropagation();
        return;
      default:
        break;
    }

    // The dialog owns the keyboard while it is open, so page shortcuts such as
    // Ctrl+S must not act behind it. Plain typing is left alone: it reaches
    // the input normally.
    if (command || event.altKey) {
      event.stopPropagation();
    }
  }

  function otherDialogOpen() {
    var dialogs = document.querySelectorAll("dialog[open]");
    for (var index = 0; index < dialogs.length; index += 1) {
      if (dialogs[index] !== state.dialog) {
        return true;
      }
    }
    return false;
  }

  function openSearch() {
    build();
    if (state.open) {
      return;
    }

    state.open = true;
    state.query = "";
    state.selected = 0;
    state.input.value = "";

    var active = document.activeElement;
    state.opener =
      active && active !== document.body && typeof active.focus === "function"
        ? active
        : null;

    showHints();
    state.dialog.showModal();
    state.input.focus();
    render();
    loadDocuments();
  }

  function showHints() {
    window.clearTimeout(state.hintTimer);
    state.hints.classList.remove("is-gone");
    state.hints.removeAttribute("aria-hidden");
    state.hintTimer = window.setTimeout(function () {
      state.hintTimer = null;
      state.hints.classList.add("is-gone");
      state.hints.setAttribute("aria-hidden", "true");
    }, HINT_TIMEOUT_MS);
  }

  function closeSearch(restoreFocus) {
    if (!state.open) {
      return;
    }

    window.clearTimeout(state.hintTimer);
    state.hintTimer = null;
    state.open = false;
    state.dialog.close();

    var opener = state.opener;
    state.opener = null;
    if (restoreFocus && opener && opener.isConnected) {
      opener.focus();
    }
  }

  function navigate(url) {
    closeSearch(false);
    window.location.assign(url);
  }

  function loginUrl() {
    return (
      "/login?next=" +
      encodeURIComponent(window.location.pathname + window.location.search)
    );
  }

  function build() {
    if (state.dialog) {
      return;
    }

    var dialog = document.createElement("dialog");
    dialog.className = "quick-open";
    dialog.setAttribute("aria-label", "Search documents");

    var search = document.createElement("div");
    search.className = "quick-open-search";
    search.innerHTML = SEARCH_ICON;

    var input = document.createElement("input");
    input.id = "quickOpenInput";
    input.className = "quick-open-input";
    input.type = "text";
    input.placeholder = "Search documents";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "Search documents");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "quickOpenList");
    search.appendChild(input);

    var list = document.createElement("ul");
    list.id = "quickOpenList";
    list.className = "quick-open-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Documents");

    var message = document.createElement("p");
    message.id = "quickOpenMessage";
    message.className = "quick-open-message";
    message.hidden = true;

    var footer = document.createElement("div");
    footer.className = "quick-open-footer";

    var count = document.createElement("span");
    count.className = "quick-open-count";
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");

    var hints = document.createElement("span");
    hints.className = "quick-open-hints";
    hints.appendChild(hint(["↑", "↓"], "Navigate"));
    hints.appendChild(hint(["Enter"], "Open"));
    hints.appendChild(hint(["Shift", "Enter"], "New tab"));
    hints.appendChild(hint(["Esc"], "Close"));

    footer.appendChild(count);
    footer.appendChild(hints);

    dialog.appendChild(search);
    dialog.appendChild(list);
    dialog.appendChild(message);
    dialog.appendChild(footer);
    document.body.appendChild(dialog);

    state.dialog = dialog;
    state.input = input;
    state.list = list;
    state.message = message;
    state.count = count;
    state.hints = hints;

    input.addEventListener("input", handleInput);
    list.addEventListener("mousemove", handleListHover);
    list.addEventListener("click", handleListClick);
    dialog.addEventListener("click", handleDialogClick);
    dialog.addEventListener("cancel", function (event) {
      event.preventDefault();
      closeSearch(true);
    });
  }

  function hint(keys, label) {
    var element = document.createElement("span");
    element.className = "quick-open-hint";
    keys.forEach(function (key) {
      var kbd = document.createElement("kbd");
      kbd.textContent = key;
      element.appendChild(kbd);
    });
    element.appendChild(document.createTextNode(label));
    return element;
  }

  function keepSearchFocused(event) {
    if (!state.open || event.target === state.input) {
      return;
    }
    // Clicking the list scrollbar must keep working, so this only restores the
    // focus a non-focusable click would otherwise move to the page behind.
    state.input.focus();
  }

  function handleInput() {
    state.query = state.input.value;
    state.selected = 0;
    render();
    state.list.scrollTop = 0;
  }

  function handleListHover(event) {
    var option = event.target.closest
      ? event.target.closest(".quick-open-option")
      : null;
    if (!option) {
      return;
    }

    var index = Number(option.getAttribute("data-index"));
    if (!Number.isFinite(index) || index === state.selected) {
      return;
    }
    state.selected = index;
    syncSelection(false);
  }

  function handleListClick(event) {
    var option = event.target.closest
      ? event.target.closest(".quick-open-option")
      : null;
    if (!option) {
      return;
    }

    state.selected = Number(option.getAttribute("data-index"));
    syncSelection(false);
    choose(event.shiftKey);
  }

  function handleDialogClick(event) {
    if (event.target !== state.dialog) {
      return;
    }

    // A click on the ::backdrop targets the dialog itself. A click inside the
    // panel targets a child, so coordinates outside the box mean the backdrop.
    var box = state.dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    ) {
      closeSearch(true);
    }
  }

  async function loadDocuments() {
    var requestId = (state.requestId += 1);
    state.loading = true;
    state.failed = false;
    state.signIn = false;
    if (!state.loaded) {
      render();
    }

    try {
      var response = await fetch("/api/documents", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (requestId !== state.requestId) {
        return;
      }

      if (response.status === 401) {
        state.loading = false;
        state.loaded = false;
        state.documents = null;
        state.signIn = true;
        render();
        return;
      }
      if (!response.ok) {
        throw new Error("The library listing failed");
      }

      var payload = await response.json();
      if (requestId !== state.requestId) {
        return;
      }

      state.documents = Array.isArray(payload.documents)
        ? payload.documents
        : [];
      state.loaded = true;
      state.loading = false;
      render();
    } catch (error) {
      if (requestId !== state.requestId) {
        return;
      }
      state.loading = false;
      if (state.loaded) {
        // Keep the listing already on screen; a refresh failure should not
        // close a search that can still be used.
        return;
      }
      state.failed = true;
      render();
    }
  }

  function render() {
    if (!state.open) {
      return;
    }

    if (state.signIn) {
      state.visible = [];
      showMessage(
        "Sign in to search your documents. Press Enter to go to the sign-in page.",
      );
      setCount("");
      return;
    }

    if (state.failed) {
      state.visible = [];
      showMessage(
        "Your documents couldn't be loaded. Check that Grapho is still running, then press Enter to try again.",
      );
      setCount("");
      return;
    }

    if (!state.loaded) {
      state.visible = [];
      showMessage("Loading your documents…");
      setCount("");
      return;
    }

    var visible = filteredDocuments();
    state.visible = visible;

    if (visible.length === 0) {
      showMessage(
        state.query.trim()
          ? "No documents match that search."
          : "No documents yet.",
      );
      setCount(countLabel(0, state.documents.length));
      return;
    }

    var terms = searchTerms(state.query);
    var fragment = document.createDocumentFragment();
    var options = [];
    visible.forEach(function (documentSummary, index) {
      var option = createOption(documentSummary, index, terms);
      options.push(option);
      fragment.appendChild(option);
    });

    state.list.replaceChildren(fragment);
    state.list.hidden = false;
    state.message.textContent = "";
    state.message.hidden = true;
    state.options = options;

    if (state.selected >= visible.length || state.selected < 0) {
      state.selected = 0;
    }
    syncSelection(false);
    setCount(countLabel(visible.length, state.documents.length));
  }

  function showMessage(text) {
    state.list.hidden = true;
    state.list.replaceChildren();
    state.message.textContent = text;
    state.message.hidden = false;
    state.options = [];
    state.input.removeAttribute("aria-activedescendant");
  }

  function setCount(text) {
    state.count.textContent = text;
  }

  function countLabel(visibleCount, total) {
    if (state.query.trim()) {
      return visibleCount + " of " + total;
    }
    return total + (total === 1 ? " document" : " documents");
  }

  function filteredDocuments() {
    var documents = state.documents || [];
    var terms = searchTerms(state.query);
    if (terms.length === 0) {
      return documents.slice().sort(compareRecent);
    }

    var matches = [];
    documents.forEach(function (documentSummary) {
      var title = documentSummary.title.toLocaleLowerCase();
      var score = 0;
      for (var index = 0; index < terms.length; index += 1) {
        var at = title.indexOf(terms[index]);
        if (at === -1) {
          return;
        }
        if (at === 0) {
          continue;
        }
        score += startsWord(title, at) ? 1 : 2;
      }
      matches.push({ document: documentSummary, score: score });
    });

    matches.sort(function (left, right) {
      return (
        left.score - right.score || compareRecent(left.document, right.document)
      );
    });
    return matches.map(function (match) {
      return match.document;
    });
  }

  function startsWord(title, index) {
    return !/[\p{L}\p{N}]/u.test(title.charAt(index - 1));
  }

  function compareRecent(left, right) {
    return (
      right.updated_at - left.updated_at || left.title.localeCompare(right.title)
    );
  }

  function searchTerms(query) {
    var seen = Object.create(null);
    return query
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(function (term) {
        if (!term || seen[term]) {
          return false;
        }
        seen[term] = true;
        return true;
      })
      .sort(function (left, right) {
        return right.length - left.length;
      });
  }

  function createOption(documentSummary, index, terms) {
    var option = document.createElement("li");
    option.className = "quick-open-option";
    option.id = "quickOpenOption" + index;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.setAttribute("data-index", String(index));

    var title = document.createElement("span");
    title.className = "quick-open-title";
    appendHighlighted(title, documentSummary.title, terms);

    var meta = document.createElement("span");
    meta.className = "quick-open-meta";
    meta.textContent = editedLabel(documentSummary.updated_at);

    option.appendChild(title);
    option.appendChild(meta);
    return option;
  }

  function appendHighlighted(container, text, terms) {
    if (terms.length === 0) {
      container.appendChild(document.createTextNode(text));
      return;
    }

    var pattern = new RegExp(
      terms
        .map(function (term) {
          return escapeRegExp(term);
        })
        .join("|"),
      "gi",
    );
    var position = 0;
    var match = pattern.exec(text);
    while (match) {
      if (match.index > position) {
        container.appendChild(
          document.createTextNode(text.slice(position, match.index)),
        );
      }
      var mark = document.createElement("mark");
      mark.className = "quick-open-match";
      mark.textContent = match[0];
      container.appendChild(mark);
      position = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (position < text.length) {
      container.appendChild(document.createTextNode(text.slice(position)));
    }
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function syncSelection(scroll) {
    state.options.forEach(function (option, index) {
      option.setAttribute("aria-selected", index === state.selected ? "true" : "false");
    });

    var selected = state.options[state.selected];
    if (!selected) {
      state.input.removeAttribute("aria-activedescendant");
      return;
    }
    state.input.setAttribute("aria-activedescendant", selected.id);
    if (scroll) {
      revealSelected(selected);
    }
  }

  function revealSelected(option) {
    var listBox = state.list.getBoundingClientRect();
    var optionBox = option.getBoundingClientRect();
    if (optionBox.top < listBox.top) {
      state.list.scrollTop -= listBox.top - optionBox.top;
    } else if (optionBox.bottom > listBox.bottom) {
      state.list.scrollTop += optionBox.bottom - listBox.bottom;
    }
  }

  function moveSelection(delta) {
    if (state.visible.length === 0) {
      return;
    }
    var count = state.visible.length;
    state.selected = ((state.selected + delta) % count + count) % count;
    syncSelection(true);
  }

  function choose(openInNewTab) {
    if (state.signIn) {
      navigate(loginUrl());
      return;
    }
    if (state.failed) {
      if (!state.loading) {
        loadDocuments();
      }
      return;
    }
    if (!state.loaded) {
      return;
    }

    var documentSummary = state.visible[state.selected];
    if (!documentSummary) {
      return;
    }
    var url = "/doc/" + encodeURIComponent(documentSummary.id);

    if (openInNewTab) {
      openInNewTabWindow(url);
      return;
    }

    if (window.location.pathname === url) {
      // The chosen document is already open in this tab; nothing to reload.
      closeSearch(true);
      return;
    }
    navigate(url);
  }

  function openInNewTabWindow(url) {
    // Browsers are free to treat window.open as a separate window, even with
    // no features requested. A real target="_blank" link goes through the
    // browser's own link handling instead, which is the path that normally
    // opens a tab in the same window; running it inside the key gesture lets
    // the browser switch to that tab as it does for any new-tab link.
    var link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    closeSearch(false);
  }

  function editedLabel(timestamp) {
    return "Edited " + relativeTime(timestamp);
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
      return dateFormatter.format(date);
    }
    return yearDateFormatter.format(date);
  }
})();
