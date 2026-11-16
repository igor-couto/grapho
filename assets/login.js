(function () {
  "use strict";

  var form = document.getElementById("loginForm");
  var input = document.getElementById("password");
  var submit = document.getElementById("loginSubmit");
  var error = document.getElementById("loginError");
  var busy = false;

  // Only ever return to a page on this server. A leading slash is required, but
  // "//host" and "/\host" are read by browsers as another site.
  function nextPath() {
    var next = new URLSearchParams(window.location.search).get("next");
    if (!next || next.charAt(0) !== "/") {
      return "/";
    }
    if (next.length > 1 && (next.charAt(1) === "/" || next.charAt(1) === "\\")) {
      return "/";
    }
    if (/[\u0000-\u001f\u007f]/.test(next)) {
      return "/";
    }
    return next;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError() {
    error.textContent = "";
    error.hidden = true;
  }

  function setBusy(isBusy) {
    busy = isBusy;
    input.disabled = isBusy;
    submit.disabled = isBusy;
    submit.textContent = isBusy ? "Unlocking…" : "Unlock";
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (busy) {
      return;
    }

    var password = input.value;
    if (!password) {
      showError("Enter the password.");
      input.focus();
      return;
    }

    clearError();
    setBusy(true);

    var response;
    try {
      response = await fetch("/api/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ password: password }),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch (networkError) {
      setBusy(false);
      showError("Couldn't reach Grapho. Check that the server is running.");
      return;
    }

    if (response.status === 204) {
      window.location.replace(nextPath());
      return;
    }

    var message = "That password is not correct.";
    try {
      var payload = await response.json();
      if (payload && payload.error) {
        message = payload.error;
      }
    } catch (parseError) {
      // Keep the plain message when the response carries no JSON.
    }

    setBusy(false);
    showError(message);
    input.focus();
    input.select();
  });
})();
