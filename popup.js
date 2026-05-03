const DEFAULT_SERVER_URL = "http://127.0.0.1:14000";

const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const statusCard = document.getElementById("statusCard");
const statusLabel = document.getElementById("statusLabel");
const statusDetail = document.getElementById("statusDetail");
const statusBadge = document.getElementById("statusBadge");
const connectionToggle = document.getElementById("connectionToggle");

let latestState = {
  connected: false,
  connecting: false,
  desiredConnected: false,
  reconnectAttempt: 0,
  lastError: "",
};
let actionPending = false;

function getViewState(state) {
  if (state.connected) {
    return {
      tone: "connected",
      label: "Connected",
      badge: "Online",
      detail: "Bridge is active. URL and token are locked while connected.",
      buttonText: "Disconnect",
      inputsLocked: true,
    };
  }
  if (state.connecting) {
    return {
      tone: "connecting",
      label: "Connecting",
      badge: "Syncing",
      detail: "Opening a secure bridge to OpenAgent...",
      buttonText: "Disconnect",
      inputsLocked: true,
    };
  }
  if (state.desiredConnected && state.reconnectAttempt > 0) {
    return {
      tone: "connecting",
      label: `Reconnecting (${state.reconnectAttempt})`,
      badge: "Retrying",
      detail: "Connection dropped. The bridge is trying to recover automatically.",
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
    detail: "Ready to connect with Browser Use.",
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

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "status" && message.state) {
    setStatus(message.state);
  }
});

refresh();
