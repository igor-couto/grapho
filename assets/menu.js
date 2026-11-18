// The standard page menu: the theme choice and the pages that manage this
// Grapho install. The library, storage, version, and not-found pages get this
// menu; the editor has its own with document actions, and the password gate
// has no menu at all.
(function () {
  "use strict";

  var SUN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.5" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.8v2M12 19.2v2M21.2 12h-2M4.8 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9 5.5 5.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  var MOON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 14.4A8.2 8.2 0 0 1 9.6 4a8.2 8.2 0 1 0 10.4 10.4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  var VERSION_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 11.2v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="7.9" r="1" fill="currentColor"/></svg>';
  var STORAGE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="6.1" rx="6.7" ry="2.7" stroke="currentColor" stroke-width="1.6"/><path d="M5.3 6.1v11.8c0 1.5 3 2.7 6.7 2.7s6.7-1.2 6.7-2.7V6.1" stroke="currentColor" stroke-width="1.6"/><path d="M5.3 12c0 1.5 3 2.7 6.7 2.7s6.7-1.2 6.7-2.7" stroke="currentColor" stroke-width="1.6"/></svg>';

  function markup() {
    var theme =
      document.documentElement.dataset.theme === "dark" ? "dark" : "light";

    return [
      '<p class="popover-label" id="themeLabel">Theme</p>',
      '<div class="theme-choice" role="group" aria-labelledby="themeLabel">',
      '<button class="theme-choice-button" type="button" role="menuitemradio" aria-checked="' +
        (theme === "light" ? "true" : "false") +
        '" data-theme-choice="light" aria-label="Light">' +
        SUN_ICON +
        "</button>",
      '<button class="theme-choice-button" type="button" role="menuitemradio" aria-checked="' +
        (theme === "dark" ? "true" : "false") +
        '" data-theme-choice="dark" aria-label="Dark">' +
        MOON_ICON +
        "</button>",
      "</div>",
      '<div class="menu-rule" role="separator"></div>',
      '<p class="popover-label">Management</p>',
      '<a class="menu-item" role="menuitem" href="/storage">' +
        STORAGE_ICON +
        "Storage</a>",
      '<a class="menu-item" role="menuitem" href="/version">' +
        VERSION_ICON +
        "Version</a>",
    ].join("");
  }

  function wire() {
    var button = document.getElementById("pageMenuButton");
    var menu = document.getElementById("pageMenu");
    if (!button || !menu) {
      return;
    }

    menu.innerHTML = markup();

    function closeMenu() {
      if (menu.hidden) {
        return;
      }
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    button.addEventListener("click", function () {
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
    });

    document.addEventListener("click", function (event) {
      if (!menu.closest(".menu-wrap").contains(event.target)) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.hidden) {
        closeMenu();
        button.focus();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
