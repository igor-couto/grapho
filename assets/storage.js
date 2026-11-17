(function () {
  "use strict";

  if (window.GraphoMenu) {
    window.GraphoMenu.wire("pageMenuButton", "pageMenu");
  }

  var els = {
    path: document.getElementById("storagePath"),
    source: document.getElementById("storageSource"),
    documents: document.getElementById("storageDocuments"),
    used: document.getElementById("storageUsed"),
    freeRow: document.getElementById("storageFreeRow"),
    free: document.getElementById("storageFree"),
    bar: document.getElementById("storageBar"),
    barFill: document.getElementById("storageBarFill"),
    form: document.getElementById("storageForm"),
    input: document.getElementById("storagePathInput"),
    save: document.getElementById("storageSave"),
    status: document.getElementById("storageStatus"),
    locked: document.getElementById("storageLocked"),
    backupList: document.getElementById("backupList"),
    backupsEmpty: document.getElementById("backupsEmpty"),
    backupsLocked: document.getElementById("backupsLocked"),
    backupStatus: document.getElementById("backupStatus"),
    backupAddRow: document.getElementById("backupAddRow"),
    backupAdd: document.getElementById("backupAdd"),
    backupAddSsh: document.getElementById("backupAddSsh"),
    backupAddGoogle: document.getElementById("backupAddGoogle"),
    backupForm: document.getElementById("backupForm"),
    backupInput: document.getElementById("backupPathInput"),
    backupSave: document.getElementById("backupSave"),
    backupCancel: document.getElementById("backupCancel"),
    sshForm: document.getElementById("sshForm"),
    sshHost: document.getElementById("sshHost"),
    sshPort: document.getElementById("sshPort"),
    sshUser: document.getElementById("sshUser"),
    sshDir: document.getElementById("sshDir"),
    sshKey: document.getElementById("sshKey"),
    sshSave: document.getElementById("sshSave"),
    sshCancel: document.getElementById("sshCancel"),
    googleForm: document.getElementById("googleForm"),
    googleClientId: document.getElementById("googleClientId"),
    googleClientSecret: document.getElementById("googleClientSecret"),
    googleFolder: document.getElementById("googleFolder"),
    googleSave: document.getElementById("googleSave"),
    googleCancel: document.getElementById("googleCancel"),
    backupTemplate: document.getElementById("backupRowTemplate"),
  };

  var state = {
    mode: null,
    opener: null,
    backupsEditable: false,
  };

  var SOURCE_NOTES = {
    environment: "Set by GRAPHO_DATA_DIR where Grapho starts.",
    settings: "Chosen here.",
    portable: "The data folder in Grapho's working directory.",
    default: "Grapho's default folder for this user.",
  };

  function loginUrl() {
    return (
      "/login?next=" +
      encodeURIComponent(window.location.pathname + window.location.search)
    );
  }

  async function request(path, options) {
    var fetchOptions = Object.assign({}, options || {});
    fetchOptions.headers = { Accept: "application/json" };

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
      if (response.status === 401) {
        window.location.assign(loginUrl());
        var authError = new Error("Sign in required");
        authError.userMessage = "Your session ended. Sign in again.";
        throw authError;
      }

      var message = "The request couldn't be completed.";
      try {
        var payload = await response.json();
        if (payload && payload.error) {
          message = payload.error;
        }
      } catch (parseError) {
        // The server sends JSON for its own errors; keep the fallback otherwise.
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

  function formatBytes(bytes) {
    if (!bytes) {
      return "0 B";
    }

    var units = ["B", "KB", "MB", "GB", "TB"];
    var value = bytes;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }

    var decimals = value >= 100 || unit === 0 ? 0 : 1;
    return value.toFixed(decimals) + " " + units[unit];
  }

  function showStatus(element, message, tone) {
    element.textContent = message;
    element.classList.toggle("is-error", tone === "error");
    element.classList.toggle("is-done", tone === "done");
  }

  function syncBackupControls() {
    els.backupAddRow.hidden = !state.backupsEditable || state.mode !== null;
    els.backupForm.hidden = state.mode !== "folder";
    els.sshForm.hidden = state.mode !== "ssh";
    els.googleForm.hidden = state.mode !== "google";
  }

  function openBackupForm(mode, opener) {
    state.mode = mode;
    state.opener = opener;
    showStatus(els.backupStatus, "", null);

    if (mode === "folder") {
      els.backupInput.value = "";
      syncBackupControls();
      els.backupInput.focus();
      return;
    }

    if (mode === "google") {
      els.googleClientId.value = "";
      els.googleClientSecret.value = "";
      els.googleFolder.value = "Grapho";
      syncBackupControls();
      els.googleClientId.focus();
      return;
    }

    els.sshHost.value = "";
    els.sshPort.value = "";
    els.sshUser.value = "";
    els.sshDir.value = "";
    els.sshKey.value = "";
    syncBackupControls();
    els.sshHost.focus();
  }

  function closeBackupForm() {
    var opener = state.opener;
    state.mode = null;
    state.opener = null;
    els.backupInput.value = "";
    syncBackupControls();
    if (opener) {
      opener.focus();
    }
  }

  function backupRow(backup, editable) {
    var item = els.backupTemplate.content.firstElementChild.cloneNode(true);
    var path = item.querySelector(".backup-path");
    var sub = item.querySelector(".backup-sub");
    var folderIcon = item.querySelector(".backup-icon-folder");
    var sshIcon = item.querySelector(".backup-icon-ssh");
    var googleIcon = item.querySelector(".backup-icon-google");

    if (backup.kind === "ssh") {
      folderIcon.remove();
      googleIcon.remove();
      var host = backup.user + "@" + backup.host;
      if (backup.port && backup.port !== 22) {
        host += ":" + backup.port;
      }
      path.textContent = host;
      sub.textContent = backup.dir;
      sub.hidden = false;
    } else if (backup.kind === "googledrive") {
      folderIcon.remove();
      sshIcon.remove();
      path.textContent = "Google Drive";
      sub.textContent = backup.folder;
      sub.hidden = false;
    } else {
      sshIcon.remove();
      googleIcon.remove();
      path.textContent = backup.path;
      sub.hidden = true;
    }

    var status = item.querySelector(".backup-state");
    if (backup.error) {
      status.textContent = "Last copy failed: " + backup.error;
      status.title = backup.error;
      status.classList.add("is-error");
    } else {
      status.textContent = "Up to date";
    }

    var remove = item.querySelector(".backup-remove");
    remove.hidden = !editable;
    remove.setAttribute("aria-label", "Remove backup " + path.textContent);
    remove.addEventListener("click", function () {
      removeBackup(backup.id, remove);
    });

    return item;
  }

  function renderBackups(data) {
    state.backupsEditable = data.backups_editable;
    els.backupList.textContent = "";

    data.backups.forEach(function (backup) {
      els.backupList.append(backupRow(backup, data.backups_editable));
    });

    els.backupList.hidden = data.backups.length === 0;
    els.backupsEmpty.hidden = data.backups.length > 0;
    els.backupsLocked.hidden = data.backups_editable;

    if (!data.backups_editable) {
      state.mode = null;
    }
    syncBackupControls();
  }

  function render(data) {
    els.path.textContent = data.path;
    els.path.classList.remove("is-loading");

    var note = SOURCE_NOTES[data.source];
    els.source.textContent = note || "";
    els.source.hidden = !note;

    els.documents.textContent = String(data.documents);
    els.used.textContent = formatBytes(data.bytes);

    if (data.disk && data.disk.total > 0) {
      els.freeRow.hidden = false;
      els.free.textContent =
        formatBytes(data.disk.free) + " free of " + formatBytes(data.disk.total);
      els.bar.hidden = false;

      var used = (data.disk.total - data.disk.free) / data.disk.total;
      var share = Math.max(0, Math.min(1, used));
      els.barFill.style.width = (share * 100).toFixed(1) + "%";
    } else {
      els.freeRow.hidden = true;
      els.bar.hidden = true;
    }

    if (data.editable) {
      els.form.hidden = false;
      els.locked.hidden = true;
    } else {
      els.form.hidden = true;
      els.locked.hidden = false;
      els.locked.textContent =
        data.source === "environment"
          ? "This folder is set when Grapho starts, so change GRAPHO_DATA_DIR and restart it to move the documents."
          : "Grapho can't remember a folder choice on this system, so the folder can't be changed here.";
    }

    renderBackups(data);
  }

  async function removeBackup(id, button) {
    button.disabled = true;
    showStatus(els.backupStatus, "Removing…", null);
    try {
      var data = await request(
        "/api/storage/backups/" + encodeURIComponent(id),
        { method: "DELETE" }
      );
      render(data);
      showStatus(
        els.backupStatus,
        "Backup removed. The copies there stay.",
        "done"
      );
    } catch (error) {
      button.disabled = false;
      showStatus(
        els.backupStatus,
        error.userMessage || "That backup couldn't be removed.",
        "error"
      );
    }
  }

  function showConnectedNotice() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("drive") !== "connected") {
      return;
    }

    showStatus(
      els.backupStatus,
      "Google Drive connected. Every save now copies there too.",
      "done"
    );
    window.history.replaceState({}, "", window.location.pathname);
  }

  async function load() {
    try {
      render(await request("/api/storage"));
      showConnectedNotice();
    } catch (error) {
      els.path.textContent = "Couldn't read the data folder.";
      els.path.classList.remove("is-loading");
      els.form.hidden = true;
      els.backupAddRow.hidden = true;
      els.backupsEmpty.hidden = true;
      showStatus(
        els.status,
        error.userMessage || "Couldn't read the data folder.",
        "error"
      );
    }
  }

  if (els.form) {
    els.form.addEventListener("submit", async function (event) {
      event.preventDefault();

      var requested = els.input.value.trim();
      if (!requested) {
        showStatus(els.status, "Enter a folder path.", "error");
        els.input.focus();
        return;
      }

      els.save.disabled = true;
      showStatus(els.status, "Copying your documents…", null);
      try {
        var data = await request("/api/storage", {
          method: "PUT",
          body: { path: requested },
        });
        render(data);
        els.input.value = "";
        showStatus(
          els.status,
          "Documents copied. Grapho writes here from now on.",
          "done"
        );
      } catch (error) {
        showStatus(
          els.status,
          error.userMessage || "That folder couldn't be used.",
          "error"
        );
      } finally {
        els.save.disabled = false;
      }
    });
  }

  if (els.backupAddRow) {
    els.backupAdd.addEventListener("click", function () {
      openBackupForm("folder", els.backupAdd);
    });
    els.backupAddSsh.addEventListener("click", function () {
      openBackupForm("ssh", els.backupAddSsh);
    });
    els.backupAddGoogle.addEventListener("click", function () {
      openBackupForm("google", els.backupAddGoogle);
    });

    els.backupCancel.addEventListener("click", closeBackupForm);
    els.sshCancel.addEventListener("click", closeBackupForm);
    els.googleCancel.addEventListener("click", closeBackupForm);

    els.backupForm.addEventListener("submit", async function (event) {
      event.preventDefault();

      var requested = els.backupInput.value.trim();
      if (!requested) {
        showStatus(els.backupStatus, "Enter a folder path.", "error");
        els.backupInput.focus();
        return;
      }

      els.backupSave.disabled = true;
      showStatus(els.backupStatus, "Copying your documents…", null);
      try {
        var data = await request("/api/storage/backups", {
          method: "POST",
          body: { path: requested },
        });
        closeBackupForm();
        render(data);
        showStatus(
          els.backupStatus,
          "Backup added. Every save now writes there too.",
          "done"
        );
      } catch (error) {
        showStatus(
          els.backupStatus,
          error.userMessage || "That folder couldn't be used.",
          "error"
        );
      } finally {
        els.backupSave.disabled = false;
      }
    });

    els.sshForm.addEventListener("submit", async function (event) {
      event.preventDefault();

      var host = els.sshHost.value.trim();
      var user = els.sshUser.value.trim();
      var dir = els.sshDir.value.trim();

      if (!host || !user || !dir) {
        showStatus(
          els.backupStatus,
          "Fill in the server, the user, and the remote folder.",
          "error"
        );
        (!host ? els.sshHost : !user ? els.sshUser : els.sshDir).focus();
        return;
      }

      var portText = els.sshPort.value.trim();
      var port = portText ? Number(portText) : 22;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        showStatus(els.backupStatus, "Enter a port between 1 and 65535.", "error");
        els.sshPort.focus();
        return;
      }

      var key = els.sshKey.value.trim();

      els.sshSave.disabled = true;
      showStatus(els.backupStatus, "Copying your documents…", null);
      try {
        var data = await request("/api/storage/backups/ssh", {
          method: "POST",
          body: {
            host: host,
            port: port,
            user: user,
            dir: dir,
            key: key || null,
          },
        });
        closeBackupForm();
        render(data);
        showStatus(
          els.backupStatus,
          "SSH backup added. Every save now copies there too.",
          "done"
        );
      } catch (error) {
        showStatus(
          els.backupStatus,
          error.userMessage || "That server couldn't be used.",
          "error"
        );
      } finally {
        els.sshSave.disabled = false;
      }
    });

    [els.backupForm, els.sshForm].forEach(function (form) {
      form.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          closeBackupForm();
        }
      });
    });

    els.googleForm.addEventListener("submit", async function (event) {
      event.preventDefault();

      var clientId = els.googleClientId.value.trim();
      var clientSecret = els.googleClientSecret.value.trim();
      var folder = els.googleFolder.value.trim() || "Grapho";

      if (!clientId || !clientSecret) {
        showStatus(
          els.backupStatus,
          "Paste the OAuth client id and client secret.",
          "error"
        );
        (!clientId ? els.googleClientId : els.googleClientSecret).focus();
        return;
      }

      els.googleSave.disabled = true;
      showStatus(els.backupStatus, "Opening Google…", null);
      try {
        var data = await request("/api/storage/backups/google", {
          method: "POST",
          body: {
            client_id: clientId,
            client_secret: clientSecret,
            folder: folder,
          },
        });
        if (!data || !data.auth_url) {
          throw new Error("Google's sign-in address was missing.");
        }
        window.location.assign(data.auth_url);
        els.googleSave.disabled = false;
      } catch (error) {
        showStatus(
          els.backupStatus,
          error.userMessage || "Google Drive couldn't be started.",
          "error"
        );
        els.googleSave.disabled = false;
      }
    });

    els.googleForm.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeBackupForm();
      }
    });
  }

  load();
})();
