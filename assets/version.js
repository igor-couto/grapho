(function () {
  "use strict";

  var status = document.getElementById("versionUpdate");
  if (!status) {
    return;
  }

  var current = status.getAttribute("data-version") || "";
  var endpoint = "https://api.github.com/repos/igor-couto/grapho/releases/latest";
  var fallback = "https://github.com/igor-couto/grapho/releases";

  function show(message, linkText, linkHref) {
    status.textContent = message;
    if (!linkText || !linkHref) {
      return;
    }

    var link = document.createElement("a");
    link.href = linkHref;
    link.textContent = linkText;
    status.append(" ", link);
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
    show("Could not check for updates.");
    return;
  }

  status.textContent = "Checking for updates…";

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
        show("Could not check for updates.");
        return;
      }

      var order = compare(latest, current);
      if (order > 0) {
        show("Grapho " + latest.replace(/^v/, "") + " is available.", "Release notes", release.html_url || fallback);
      } else if (order === 0) {
        show("This is the latest release.");
      } else {
        show("This build is newer than the latest release.");
      }
    })
    .catch(function () {
      show("Could not check for updates.");
    })
    .finally(finish);
})();
