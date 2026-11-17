(function () {
  "use strict";

  var STORAGE_KEY = "grapho-theme";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (error) {
      return null;
    }
  }

  function preferredTheme() {
    return media && media.matches ? "dark" : "light";
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

  applyTheme(storedTheme() || preferredTheme(), false);

  document.addEventListener("DOMContentLoaded", function () {
    syncControls();

    document.querySelectorAll("[data-theme-choice]").forEach(function (button) {
      button.addEventListener("click", function () {
        applyTheme(button.getAttribute("data-theme-choice"), true);
      });
    });
  });

  if (media) {
    var onSystemChange = function (event) {
      if (!storedTheme()) {
        applyTheme(event.matches ? "dark" : "light", false);
      }
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(onSystemChange);
    }
  }
})();
