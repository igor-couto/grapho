(function () {
  "use strict";

  if (window.GraphoMenu) {
    window.GraphoMenu.wire("pageMenuButton", "pageMenu");
  }

  var els = {
    path: document.getElementById("storagePath"),
    source: document.getElementById("storageSource"),
    edit: document.getElementById("storageEdit"),
    status: document.getElementById("storageStatus"),
    locked: document.getElementById("storageLocked"),
    folderDialog: document.getElementById("folderDialog"),
    folderForm: document.getElementById("folderForm"),
    folderInput: document.getElementById("folderPathInput"),
    folderError: document.getElementById("folderError"),
    folderConfirm: document.getElementById("folderConfirm"),
    folderCancel: document.getElementById("folderCancel"),
    backupRemoveDialog: document.getElementById("backupRemoveDialog"),
    backupRemoveForm: document.getElementById("backupRemoveForm"),
    backupRemoveDescription: document.getElementById("backupRemoveDescription"),
    backupRemoveError: document.getElementById("backupRemoveError"),
    backupRemoveConfirm: document.getElementById("backupRemoveConfirm"),
    backupRemoveCancel: document.getElementById("backupRemoveCancel"),
    documents: document.getElementById("storageDocuments"),
    used: document.getElementById("storageUsed"),
    freeRow: document.getElementById("storageFreeRow"),
    free: document.getElementById("storageFree"),
    bar: document.getElementById("storageBar"),
    barFill: document.getElementById("storageBarFill"),
    spaceAdd: document.getElementById("spaceAdd"),
    spaceList: document.getElementById("spaceList"),
    spaceStatus: document.getElementById("spaceStatus"),
    spaceTemplate: document.getElementById("spaceRowTemplate"),
    spaceDialog: document.getElementById("spaceDialog"),
    spaceForm: document.getElementById("spaceForm"),
    spaceTitle: document.getElementById("spaceTitle"),
    spaceName: document.getElementById("spaceName"),
    spaceFolder: document.getElementById("spaceFolder"),
    spaceImportOption: document.getElementById("spaceImportOption"),
    spaceImport: document.getElementById("spaceImport"),
    spaceError: document.getElementById("spaceError"),
    spaceSave: document.getElementById("spaceSave"),
    spaceCancel: document.getElementById("spaceCancel"),
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
    path: "",
    busy: false,
    removing: null,
    removingBusy: false,
    mode: null,
    opener: null,
    backupsEditable: false,
    editingSpace: null,
    spaceBusy: false,
    spaceOpener: null,
  };

  var SOURCE_NOTES = {
    environment: "Set by GRAPHO_DATA_DIR where Grapho starts.",
    settings: "Chosen here.",
    portable: "The data folder in Grapho's working directory.",
    default: "Grapho's default folder for this user.",
  };

  // Warn only when the disk is nearly full: below 5% free it is a problem,
  // while Explorer's 10% red bar is early on large drives.
  var LOW_SPACE_SHARE = 0.05;

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

    var label = path.textContent;
    if (!sub.hidden) {
      label += " " + sub.textContent;
    }

    var remove = item.querySelector(".backup-remove");
    remove.hidden = !editable;
    remove.setAttribute("aria-label", "Remove backup " + label);
    remove.addEventListener("click", function () {
      openBackupRemoval(backup.id, label, remove);
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
    showStatus(els.status, "", null);
    state.path = data.path;
    els.path.textContent = data.path;
    els.path.classList.remove("is-loading");
    els.edit.hidden = !data.editable;

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
      els.bar.classList.toggle(
        "is-low",
        data.disk.free / data.disk.total < LOW_SPACE_SHARE
      );
    } else {
      els.freeRow.hidden = true;
      els.bar.hidden = true;
      els.bar.classList.remove("is-low");
    }

    if (data.editable) {
      els.locked.hidden = true;
    } else {
      els.locked.hidden = false;
      els.locked.textContent =
        data.source === "environment"
          ? "This folder is set when Grapho starts, so change GRAPHO_DATA_DIR and restart it to move the documents."
          : "Grapho can't remember a folder choice on this system, so the folder can't be changed here.";
    }

    renderSpaces(data.spaces);
    renderBackups(data);
  }

  function renderSpaces(spaces) {
    els.spaceList.replaceChildren();
    for (var space of spaces) {
      var row = els.spaceTemplate.content.firstElementChild.cloneNode(true);
      row.dataset.spaceId = space.id;
      row.querySelector(".storage-space-name").textContent = space.name;
      row.querySelector(".backup-path").textContent = space.folder || "Main data folder";
      row.querySelector(".backup-state").hidden = space.available !== false;
      var button = row.querySelector("button");
      button.setAttribute("aria-label", "Edit " + space.name);
      button.title = "Edit Space";
      els.spaceList.append(row);
    }
    els.spaceList.hidden = spaces.length === 0;
    els.spaceAdd.hidden = false;
    state.spaces = spaces;
  }

  function openSpaceDialog(space, opener) {
    state.editingSpace = space;
    state.spaceOpener = opener;
    els.spaceTitle.textContent = space ? "Edit Space" : "New Space";
    els.spaceName.value = space ? space.name : "";
    els.spaceFolder.value = space ? space.folder || "" : "";
    els.spaceImportOption.hidden = Boolean(space);
    els.spaceImport.checked = false;
    syncSpaceImport();
    els.spaceSave.textContent = space ? "Save" : "Create Space";
    els.spaceError.hidden = true;
    showStatus(els.spaceStatus, "", null);
    els.spaceDialog.showModal();
    els.spaceName.focus();
  }

  function syncSpaceImport() {
    els.spaceImport.disabled = state.spaceBusy || els.spaceImportOption.hidden || !els.spaceFolder.value.trim();
  }

  function setSpaceBusy(busy) {
    state.spaceBusy = busy;
    els.spaceForm.setAttribute("aria-busy", String(busy));
    els.spaceSave.disabled = busy;
    els.spaceCancel.disabled = busy;
    els.spaceName.disabled = busy;
    els.spaceFolder.disabled = busy;
    syncSpaceImport();
    els.spaceSave.textContent = busy ? "Saving…" : state.editingSpace ? "Save" : "Create Space";
  }

  async function saveSpace(event) {
    event.preventDefault();
    if (state.spaceBusy) return;
    var space = state.editingSpace;
    var body = {
      name: els.spaceName.value,
      folder: els.spaceFolder.value,
      import_markdown: !els.spaceImport.disabled && els.spaceImport.checked,
    };
    els.spaceError.hidden = true;
    setSpaceBusy(true);
    try {
      var data = await request("/api/storage/spaces" + (space ? "/" + encodeURIComponent(space.id) : ""), {
        method: space ? "PUT" : "POST",
        body: body,
      });
      render(data);
      els.spaceDialog.close();
      var message = space ? "Space saved." : "Space created.";
      if (data.imported_documents === 0) message += " No Markdown files found.";
      if (data.imported_documents === 1) message += " Imported 1 Markdown file.";
      if (data.imported_documents > 1) message += " Imported " + data.imported_documents + " Markdown files.";
      showStatus(els.spaceStatus, message, "done");
    } catch (error) {
      els.spaceError.textContent = error.userMessage || "The Space couldn't be saved. Try again.";
      els.spaceError.hidden = false;
    } finally {
      setSpaceBusy(false);
    }
  }

  function showFolderError(message) {
    els.folderError.textContent = message || "";
    els.folderError.hidden = !message;
    if (message) {
      els.folderInput.setAttribute("aria-invalid", "true");
      els.folderInput.setAttribute("aria-describedby", "folderHint folderError");
    } else {
      els.folderInput.removeAttribute("aria-invalid");
      els.folderInput.setAttribute("aria-describedby", "folderHint");
    }
  }

  function setFolderBusy(busy) {
    state.busy = busy;
    els.folderInput.disabled = busy;
    els.folderCancel.disabled = busy;
    els.folderConfirm.disabled = busy;
    els.folderConfirm.textContent = busy ? "Copying…" : "Use this folder";
    els.folderForm.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) {
      showFolderError("");
    }
  }

  function openFolderDialog() {
    showFolderError("");
    setFolderBusy(false);
    els.folderInput.value = state.path;
    els.folderDialog.showModal();
    window.requestAnimationFrame(function () {
      els.folderInput.focus();
      els.folderInput.select();
    });
  }

  function closeFolderDialog() {
    if (state.busy) {
      return;
    }
    if (els.folderDialog.open) {
      els.folderDialog.close();
    }
  }

  async function changeFolder() {
    if (state.busy) {
      return;
    }

    var requested = els.folderInput.value.trim();
    if (!requested) {
      showFolderError("Enter a folder path.");
      els.folderInput.focus();
      return;
    }
    if (requested === state.path) {
      showFolderError("That is already the folder Grapho uses.");
      els.folderInput.focus();
      return;
    }

    setFolderBusy(true);
    try {
      var data = await request("/api/storage", {
        method: "PUT",
        body: { path: requested },
      });
      setFolderBusy(false);
      els.folderDialog.close();
      render(data);
      showStatus(
        els.status,
        "Documents copied. Grapho writes here from now on.",
        "done"
      );
    } catch (error) {
      setFolderBusy(false);
      showFolderError(error.userMessage || "That folder couldn't be used.");
      els.folderInput.focus();
    }
  }

  function showRemoveError(message) {
    els.backupRemoveError.textContent = message || "";
    els.backupRemoveError.hidden = !message;
  }

  function setRemoveBusy(busy) {
    state.removingBusy = busy;
    els.backupRemoveForm.setAttribute("aria-busy", busy ? "true" : "false");
    els.backupRemoveConfirm.disabled = busy;
    els.backupRemoveCancel.disabled = busy;
    els.backupRemoveConfirm.textContent = busy ? "Removing…" : "Remove backup";
    if (busy) {
      showRemoveError("");
    }
  }

  function openBackupRemoval(id, label, opener) {
    state.removing = { id: id, opener: opener };
    els.backupRemoveDescription.textContent =
      "Grapho stops copying saves to “" +
      label +
      "”. The copies already there stay.";
    showRemoveError("");
    setRemoveBusy(false);
    els.backupRemoveDialog.showModal();
    window.requestAnimationFrame(function () {
      els.backupRemoveCancel.focus();
    });
  }

  function closeBackupRemoval() {
    if (state.removingBusy) {
      return;
    }
    if (els.backupRemoveDialog.open) {
      els.backupRemoveDialog.close();
    }
  }

  async function confirmBackupRemoval() {
    var pending = state.removing;
    if (!pending || state.removingBusy) {
      return;
    }

    setRemoveBusy(true);
    try {
      var data = await request(
        "/api/storage/backups/" + encodeURIComponent(pending.id),
        { method: "DELETE" }
      );
      setRemoveBusy(false);
      els.backupRemoveDialog.close();
      render(data);
      showStatus(
        els.backupStatus,
        "Backup removed. The copies there stay.",
        "done"
      );
    } catch (error) {
      setRemoveBusy(false);
      showRemoveError(error.userMessage || "That backup couldn't be removed.");
      els.backupRemoveConfirm.focus();
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
      els.edit.hidden = true;
      els.backupAddRow.hidden = true;
      els.backupsEmpty.hidden = true;
      showStatus(
        els.status,
        error.userMessage || "Couldn't read the data folder.",
        "error"
      );
    }
  }

  if (els.edit) {
    els.edit.addEventListener("click", openFolderDialog);
  }

  els.spaceAdd.addEventListener("click", function () {
    openSpaceDialog(null, els.spaceAdd);
  });
  els.spaceList.addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    var id = button.closest("[data-space-id]").dataset.spaceId;
    openSpaceDialog(state.spaces.find(function (space) { return space.id === id; }), button);
  });
  els.spaceForm.addEventListener("submit", saveSpace);
  els.spaceFolder.addEventListener("input", syncSpaceImport);
  els.spaceCancel.addEventListener("click", function () {
    els.spaceDialog.close();
  });
  els.spaceDialog.addEventListener("cancel", function (event) {
    if (state.spaceBusy) event.preventDefault();
  });
  els.spaceDialog.addEventListener("close", function () {
    var opener = state.spaceOpener;
    if (!opener.isConnected && state.editingSpace) {
      opener = els.spaceList.querySelector('[data-space-id="' + CSS.escape(state.editingSpace.id) + '"] button');
    }
    (opener || els.spaceAdd).focus();
    state.editingSpace = null;
    state.spaceOpener = null;
  });

  if (els.folderDialog) {
    els.folderForm.addEventListener("submit", function (event) {
      event.preventDefault();
      changeFolder();
    });

    els.folderCancel.addEventListener("click", closeFolderDialog);

    els.folderInput.addEventListener("input", function () {
      showFolderError("");
    });

    els.folderDialog.addEventListener("cancel", function (event) {
      if (state.busy) {
        event.preventDefault();
      }
    });

    els.folderDialog.addEventListener("click", function (event) {
      if (event.target === els.folderDialog) {
        closeFolderDialog();
      }
    });

    els.folderDialog.addEventListener("close", function () {
      setFolderBusy(false);
      showFolderError("");
      els.folderInput.value = "";
      if (!els.edit.hidden) {
        els.edit.focus();
      }
    });
  }

  if (els.backupRemoveDialog) {
    els.backupRemoveForm.addEventListener("submit", function (event) {
      event.preventDefault();
      confirmBackupRemoval();
    });

    els.backupRemoveCancel.addEventListener("click", closeBackupRemoval);

    els.backupRemoveDialog.addEventListener("cancel", function (event) {
      if (state.removingBusy) {
        event.preventDefault();
      }
    });

    els.backupRemoveDialog.addEventListener("click", function (event) {
      if (event.target === els.backupRemoveDialog) {
        closeBackupRemoval();
      }
    });

    els.backupRemoveDialog.addEventListener("close", function () {
      var pending = state.removing;
      state.removing = null;
      setRemoveBusy(false);
      showRemoveError("");

      var target =
        pending && pending.opener && pending.opener.isConnected
          ? pending.opener
          : !els.backupAddRow.hidden
            ? els.backupAdd
            : null;
      if (target) {
        target.focus();
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
