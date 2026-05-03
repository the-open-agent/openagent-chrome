const serverInput = document.getElementById("serverUrl");
const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");

function setStatus(state) {
  serverInput.value = state.serverUrl || "http://127.0.0.1:14000";
  tokenInput.value = state.token || "";
  statusEl.classList.toggle("connected", Boolean(state.connected));
  statusEl.classList.toggle("error", Boolean(state.lastError));
  if (state.connected) {
    statusEl.textContent = "Connected";
  } else if (state.connecting) {
    statusEl.textContent = "Connecting...";
  } else if (state.desiredConnected && state.reconnectAttempt > 0) {
    statusEl.textContent = `Reconnecting (${state.reconnectAttempt})...`;
  } else if (state.lastError) {
    statusEl.textContent = `Disconnected: ${state.lastError}`;
  } else {
    statusEl.textContent = "Disconnected";
  }
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

connectButton.addEventListener("click", async () => {
  const response = await send({
    type: "connect",
    serverUrl: serverInput.value,
    token: tokenInput.value,
  });
  if (response && response.state) {
    setStatus(response.state);
  }
});

disconnectButton.addEventListener("click", async () => {
  const response = await send({type: "disconnect"});
  if (response && response.state) {
    setStatus(response.state);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "status" && message.state) {
    setStatus(message.state);
  }
});

refresh();
