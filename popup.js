const DEFAULT_SERVER_URL = "http://127.0.0.1:14000";

const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const statusCard = document.getElementById("statusCard");
const statusLabel = document.getElementById("statusLabel");
const statusDetail = document.getElementById("statusDetail");
const statusBadge = document.getElementById("statusBadge");
const connectionToggle = document.getElementById("connectionToggle");
const recorderDetail = document.getElementById("recorderDetail");
const recorderBadge = document.getElementById("recorderBadge");
const recordToggle = document.getElementById("recordToggle");
const openRecorder = document.getElementById("openRecorder");
const webActionsDetail = document.getElementById("webActionsDetail");
const webActionsList = document.getElementById("webActionsList");
const refreshWebActions = document.getElementById("refreshWebActions");

let latestState = {
  connected: false,
  connecting: false,
  desiredConnected: false,
  reconnectAttempt: 0,
  lastError: "",
};
let actionPending = false;
let recorderState = {
  active: false,
  stepCount: 0,
};
let webActions = [];

function getViewState(state) {
  if (state.connected) {
    return {
      tone: "connected",
      label: "Connected",
      badge: "Online",
      detail: "Bridge is running. URL and token are locked while connected.",
      buttonText: "Disconnect",
      inputsLocked: true,
    };
  }
  if (state.connecting) {
    return {
      tone: "connecting",
      label: "Connecting",
      badge: "Opening",
      detail: "Opening websocket channel to the configured endpoint.",
      buttonText: "Disconnect",
      inputsLocked: true,
    };
  }
  if (state.desiredConnected && state.reconnectAttempt > 0) {
    return {
      tone: "connecting",
      label: `Reconnecting (${state.reconnectAttempt})`,
      badge: "Retrying",
      detail: "Connection dropped. Trying to reconnect automatically.",
      buttonText: "Disconnect",
      inputsLocked: true,
    };
  }
  if (state.lastError) {
    return {
      tone: "error",
      label: "Disconnected",
      badge: "Error",
      detail: state.lastError,
      buttonText: "Connect",
      inputsLocked: false,
    };
  }
  return {
    tone: "idle",
    label: "Disconnected",
    badge: "Idle",
    detail: "Set the endpoint, then bring the bridge online.",
    buttonText: "Connect",
    inputsLocked: false,
  };
}

function setStatus(state) {
  latestState = {...latestState, ...state};
  serverInput.value = latestState.serverUrl || DEFAULT_SERVER_URL;
  tokenInput.value = latestState.token || "";

  const viewState = getViewState(latestState);
  statusCard.dataset.state = viewState.tone;
  connectionToggle.dataset.state = viewState.buttonText === "Disconnect" ? "connected" : "idle";
  statusLabel.textContent = viewState.label;
  statusDetail.textContent = viewState.detail;
  statusBadge.textContent = viewState.badge;
  connectionToggle.textContent = actionPending ? "Please wait..." : viewState.buttonText;
  connectionToggle.disabled = actionPending;
  serverInput.disabled = viewState.inputsLocked || actionPending;
  tokenInput.disabled = viewState.inputsLocked || actionPending;
}

function setRecorderState(state) {
  recorderState = {...recorderState, ...(state || {})};
  recorderBadge.textContent = recorderState.active ? "Recording" : recorderState.stepCount > 0 ? `${recorderState.stepCount} steps` : "Idle";
  recorderDetail.textContent = recorderState.active
    ? `Recording human actions on the active page. ${recorderState.stepCount || 0} step(s) captured.`
    : recorderState.stepCount > 0
      ? `${recorderState.stepCount} step(s) captured. Open the editor to review replay selectors.`
      : "Record a human demonstration, then edit stable replay steps.";
  recordToggle.textContent = recorderState.active ? "Stop Recording" : "Start Recording";
  recordToggle.dataset.state = recorderState.active ? "recording" : "idle";
  openRecorder.disabled = recorderState.active || recorderState.stepCount === 0;
}

async function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ok: false, error: err.message});
        return;
      }
      resolve(response);
    });
  });
}

async function refresh() {
  const response = await send({type: "status"});
  if (response && response.state) {
    setStatus(response.state);
  }
  const recorder = await send({type: "recorderStatus"});
  if (recorder && recorder.state) {
    setRecorderState(recorder.state);
  }
  await refreshCurrentPageActions();
}

function actionIdentity(action) {
  return {
    action_group: action.action_group || action.actionGroup || "",
    name: action.name || "",
  };
}

function renderWebActions() {
  webActionsList.textContent = "";
  if (webActions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-actions";
    empty.textContent = "No actions saved for this site yet. Record one above.";
    webActionsList.appendChild(empty);
    return;
  }
  for (const action of webActions) {
    const identity = actionIdentity(action);
    const card = document.createElement("article");
    card.className = "web-action-card";

    const title = document.createElement("div");
    title.className = "web-action-title";
    title.textContent = `${identity.action_group} / ${identity.name}`;
    const url = document.createElement("div");
    url.className = "web-action-url";
    url.textContent = action.url || "No start URL";

    const controls = document.createElement("div");
    controls.className = "web-action-controls";
    const edit = document.createElement("button");
    edit.className = "ghost-action";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", async () => {
      webActionsDetail.textContent = `Opening ${identity.action_group} / ${identity.name}...`;
      const response = await send({type: "editWebAction", ...identity});
      webActionsDetail.textContent = response && response.error ? response.error : "Opened action editor.";
    });

    const rerecord = document.createElement("button");
    rerecord.className = "secondary-action";
    rerecord.type = "button";
    rerecord.textContent = "Re-record";
    rerecord.addEventListener("click", async () => {
      webActionsDetail.textContent = `Re-recording ${identity.action_group} / ${identity.name}...`;
      const response = await send({type: "rerecordWebAction", ...identity});
      if (response && response.state) {
        setRecorderState(response.state);
      }
      webActionsDetail.textContent = response && response.error ? response.error : "Recording started. Perform the flow, then stop recording.";
    });

    const del = document.createElement("button");
    del.className = "danger-action";
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete ${identity.action_group} / ${identity.name}?`)) {
        return;
      }
      const response = await send({type: "deleteWebAction", ...identity});
      if (!response || !response.ok) {
        webActionsDetail.textContent = response && response.error ? response.error : "Could not delete saved action.";
        return;
      }
      await refreshCurrentPageActions();
    });

    controls.append(edit, rerecord, del);
    card.append(title, url, controls);
    webActionsList.appendChild(card);
  }
}

async function refreshCurrentPageActions() {
  if (!webActionsDetail || !webActionsList) {
    return;
  }
  let response = await send({type: "listWebActionsForCurrentTab"});
  if (!response || !response.ok) {
    webActions = [];
    webActionsDetail.textContent = response && response.error ? response.error : "Could not load saved actions.";
    renderWebActions();
    return;
  } else {
    webActions = Array.isArray(response.actions) ? response.actions : [];
  }
  let host = "current site";
  try {
    host = response.tab && response.tab.url ? new URL(response.tab.url).hostname : host;
  } catch (error) {
    host = "current site";
  }
  webActionsDetail.textContent = `${webActions.length} action(s) matched ${host}.`;
  renderWebActions();
}

connectionToggle.addEventListener("click", async () => {
  actionPending = true;
  setStatus(latestState);

  const shouldDisconnect = latestState.connected || latestState.connecting || latestState.desiredConnected;
  const response = shouldDisconnect
    ? await send({type: "disconnect"})
    : await send({
      type: "connect",
      serverUrl: serverInput.value,
      token: tokenInput.value,
    });

  actionPending = false;
  if (response && response.state) {
    setStatus(response.state);
    return;
  }
  if (response && response.error) {
    setStatus({...latestState, lastError: response.error, connected: false, connecting: false, desiredConnected: false});
    return;
  }
  await refresh();
});

recordToggle.addEventListener("click", async () => {
  actionPending = true;
  setStatus(latestState);
  const response = recorderState.active
    ? await send({type: "stopRecording"})
    : await send({type: "startRecording"});
  actionPending = false;
  if (response && response.state) {
    setRecorderState(response.state);
  }
  if (response && response.error) {
    recorderDetail.textContent = response.error;
  }
  setStatus(latestState);
});

openRecorder.addEventListener("click", async () => {
  const response = await send({type: "openRecorder"});
  if (response && response.error) {
    recorderDetail.textContent = response.error;
  }
});

refreshWebActions.addEventListener("click", refreshCurrentPageActions);

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "status" && message.state) {
    setStatus(message.state);
  }
  if (message && message.type === "recorderStatus" && message.state) {
    setRecorderState(message.state);
  }
});

refresh();
