(function () {
  "use strict";

  // Inline copies of assets/icons/green_check.svg and assets/icons/download.svg.
  // Both are decorative: the text beside them says what happened, and the fill
  // follows the status colour from app.css.
  var ICONS = {
    current:
      '<svg viewBox="0 0 18 18" aria-hidden="true"><g transform="translate(-3996 -50)"><path fill="currentColor" fill-rule="evenodd" d="M4005 66A7 7 0 1 0 4005 52A7 7 0 0 0 4005 66M4000.25 59.5L4001.307 58.443L4003.5 60.628L4008.693 55.435L4009.75 56.5L4003.5 62.75Z"/></g></svg>',
    available:
      '<svg viewBox="0 0 18 18" aria-hidden="true"><g transform="translate(-810 0)"><path fill="currentColor" d="M823 8L821.94 6.94L819.75 9.13L819.75 2L818.25 2L818.25 9.13L816.06 6.94L815 8L819 12ZM823.5 12L823.5 13.5L814.5 13.5L814.5 12L813 12L813 13.5C813 14.33 813.67 15 814.5 15L823.5 15C824.33 15 825 14.33 825 13.5L825 12Z"/></g></svg>',
  };

  var status = document.getElementById("versionUpdate");
  if (!status) {
    return;
  }

  var current = status.getAttribute("data-version") || "";
  var endpoint = "https://api.github.com/repos/igor-couto/grapho/releases/latest";
  var fallback = "https://github.com/igor-couto/grapho/releases";

  // The state names both the icon and the semantic colour in app.css:
  // "current" is the green check, "available" the accent download arrow.
  function show(state, message, linkText, linkHref) {
    status.className = "version-update" + (state ? " is-" + state : "");
    status.textContent = "";
    if (state) {
      status.insertAdjacentHTML("afterbegin", ICONS[state]);
    }

    var text = document.createElement("span");
    text.textContent = message;

    if (linkText && linkHref) {
      var link = document.createElement("a");
      link.href = linkHref;
      link.textContent = linkText;
      text.append(" ", link);
    }

    status.append(text);
  }

  function compare(left, right) {
    var a = left.replace(/^v/, "").split("-")[0].split(".");
    var b = right.replace(/^v/, "").split("-")[0].split(".");

    for (var index = 0; index < 3; index += 1) {
      var one = Number(a[index] || 0);
      var other = Number(b[index] || 0);
      if (one !== other) {
        return one < other ? -1 : 1;
      }
    }
    return 0;
  }

  if (!current) {
    show(null, "Could not check for updates.");
    return;
  }

  show(null, "Checking for updates…");

  // A stalled request would leave the line saying "Checking" forever.
  var controller = new AbortController();
  var timeout = window.setTimeout(function () {
    controller.abort();
  }, 8000);

  function finish() {
    window.clearTimeout(timeout);
  }

  window
    .fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    })
    .then(function (response) {
      if (!response.ok) {
        throw new Error("the release check failed");
      }
      return response.json();
    })
    .then(function (release) {
      var latest = String(release.tag_name || "");
      if (!latest) {
        show(null, "Could not check for updates.");
        return;
      }

      var order = compare(latest, current);
      if (order > 0) {
        show(
          "available",
          "Grapho " + latest.replace(/^v/, "") + " is available.",
          "Release notes",
          release.html_url || fallback,
        );
      } else if (order === 0) {
        show("current", "This is the latest release.");
      } else {
        show(null, "This build is newer than the latest release.");
      }
    })
    .catch(function () {
      show(null, "Could not check for updates.");
    })
    .finally(finish);
})();
