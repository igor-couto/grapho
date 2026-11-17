(function () {
  "use strict";

  var STORAGE_KEY = "grapho-theme";
  var root = document.documentElement;

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function currentTheme() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  function syncControls() {
    var theme = currentTheme();

    document.querySelectorAll("[data-theme-choice]").forEach(function (button) {
      button.setAttribute(
        "aria-checked",
        button.getAttribute("data-theme-choice") === theme ? "true" : "false",
      );
    });

    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      meta.setAttribute("content", theme === "dark" ? "#232126" : "#f3efe6");
    });
  }

  function applyTheme(theme, remember) {
    root.dataset.theme = theme;
    if (remember) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
      } catch (error) {
        // A blocked storage area should never prevent a theme change.
      }
    }
    syncControls();
  }

  // Dark is the default until the reader picks a theme; the stored choice is
  // the reader's and always wins. The OS preference is deliberately ignored.
  applyTheme(storedTheme() || "dark", false);

  document.addEventListener("DOMContentLoaded", function () {
    syncControls();

    document.querySelectorAll("[data-theme-choice]").forEach(function (button) {
      button.addEventListener("click", function () {
        applyTheme(button.getAttribute("data-theme-choice"), true);
      });
    });
  });
})();
