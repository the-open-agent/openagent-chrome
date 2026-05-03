const BRIDGE_PATH = "/api/browser-use/casibase-browser-extension";
const DEFAULT_SERVER_URL = "http://127.0.0.1:14000";
const HEARTBEAT_MS = 20000;
const PONG_TIMEOUT_MS = 45000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const KEEPALIVE_ALARM = "casibase-bridge-keepalive";

let socket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let intentionalClose = false;
let lastPongAt = 0;
const snapshotTargetsByTab = new Map();

let currentState = {
  serverUrl: DEFAULT_SERVER_URL,
  token: "",
  desiredConnected: false,
  controlledTabId: 0,
  connected: false,
  connecting: false,
  reconnectAttempt: 0,
  lastError: "",
};

function callbackApi(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(result);
    });
  });
}

async function loadState() {
  const stored = await chrome.storage.local.get(["serverUrl", "token", "desiredConnected", "controlledTabId"]);
  currentState = {
    ...currentState,
    serverUrl: stored.serverUrl || DEFAULT_SERVER_URL,
    token: stored.token || "",
    desiredConnected: Boolean(stored.desiredConnected),
    controlledTabId: normalizeTabId(stored.controlledTabId),
  };
  return currentState;
}

async function saveState(update) {
  currentState = {...currentState, ...update};
  await chrome.storage.local.set({
    serverUrl: currentState.serverUrl,
    token: currentState.token,
    desiredConnected: currentState.desiredConnected,
    controlledTabId: normalizeTabId(currentState.controlledTabId),
  });
  broadcastStatus();
}

function normalizeWebSocketUrl(serverUrl, token) {
  let raw = (serverUrl || DEFAULT_SERVER_URL).trim();
  if (!/^https?:\/\//i.test(raw) && !/^wss?:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  const url = new URL(raw);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (!url.pathname || url.pathname === "/") {
    url.pathname = BRIDGE_PATH;
  }
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

function normalizeHttpUrl(serverUrl) {
  let raw = (serverUrl || DEFAULT_SERVER_URL).trim();
  if (!/^https?:\/\//i.test(raw) && !/^wss?:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  const url = new URL(raw);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  return url;
}

function normalizeTabId(value) {
  const tabId = Number(value || 0);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : 0;
}

async function connect(serverUrl, token) {
  clearReconnectTimer();
  intentionalClose = false;
  await saveState({
    serverUrl: serverUrl || DEFAULT_SERVER_URL,
    token: token || "",
    desiredConnected: true,
    reconnectAttempt: 0,
    lastError: "",
  });
  openSocket();
}

function openSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  currentState.connecting = true;
  currentState.lastError = "";
  broadcastStatus();

  let wsUrl;
  try {
    wsUrl = normalizeWebSocketUrl(currentState.serverUrl, currentState.token);
  } catch (error) {
    currentState.connecting = false;
    currentState.connected = false;
    currentState.lastError = `Invalid OpenAgent URL: ${error.message || String(error)}`;
    broadcastStatus();
    scheduleReconnect();
    return;
  }

  intentionalClose = false;
  const ws = new WebSocket(wsUrl);
  socket = ws;

  ws.addEventListener("open", () => {
    if (socket !== ws) {
      return;
    }
    currentState.connected = true;
    currentState.connecting = false;
    currentState.reconnectAttempt = 0;
    currentState.lastError = "";
    lastPongAt = Date.now();
    sendHello();
    startHeartbeat();
    broadcastStatus();
  });

  ws.addEventListener("message", async (event) => {
    if (socket !== ws) {
      return;
    }
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (message.type === "pong") {
      lastPongAt = Date.now();
      return;
    }
    if (message.type === "ping") {
      sendRaw({type: "pong", ts: Date.now()});
      return;
    }
    if (message.type === "server_hello") {
      return;
    }
    if (message.type !== "call") {
      return;
    }
    try {
      if (message.command === "disconnect") {
        await stopDesiredConnection();
        sendResult(message.id, {disconnected: true});
        setTimeout(() => {
          if (socket === ws) {
            ws.close();
          }
        }, 0);
        return;
      }
      const result = await executeCommand(message.command, message.payload || {});
      sendResult(message.id, result);
    } catch (error) {
      sendError(message.id, error);
    }
  });

  ws.addEventListener("error", () => {
    if (socket !== ws) {
      return;
    }
    currentState.lastError = "WebSocket error";
    broadcastStatus();
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) {
      return;
    }
    stopHeartbeat();
    currentState.connected = false;
    currentState.connecting = false;
    socket = null;
    broadcastStatus();
    if (!intentionalClose && currentState.desiredConnected) {
      scheduleReconnect();
    }
  });
}

async function stopDesiredConnection() {
  intentionalClose = true;
  clearReconnectTimer();
  stopHeartbeat();
  await saveState({desiredConnected: false, connected: false, connecting: false});
}

async function disconnect() {
  await stopDesiredConnection();
  if (socket) {
    socket.close();
  }
  socket = null;
  currentState.connected = false;
  currentState.connecting = false;
  broadcastStatus();
}

function scheduleReconnect() {
  if (!currentState.desiredConnected || reconnectTimer) {
    return;
  }
  const attempt = currentState.reconnectAttempt || 0;
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  currentState.reconnectAttempt = attempt + 1;
  broadcastStatus();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentState.desiredConnected && !socket) {
      openSocket();
    }
  }, delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  sendHeartbeat();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendHeartbeat() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
    currentState.lastError = "Bridge heartbeat timed out";
    socket.close();
    return;
  }
  sendRaw({type: "ping", ts: Date.now()});
}

function sendHello() {
  sendRaw({
    type: "hello",
    name: "openagent-browser-bridge",
    version: chrome.runtime.getManifest().version,
  });
}

function sendRaw(value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(value));
  return true;
}

function sendResult(id, result) {
  sendRaw({type: "result", id, ok: true, result});
}

function sendError(id, error) {
  sendRaw({
    type: "result",
    id,
    ok: false,
    error: error && error.message ? error.message : String(error),
  });
}

function broadcastStatus() {
  try {
    chrome.runtime.sendMessage({type: "status", state: getStatus()}, () => {
      void chrome.runtime.lastError;
    });
  } catch (error) {
    // No popup is open.
  }
}

function getStatus() {
  return {
    serverUrl: currentState.serverUrl,
    token: currentState.token,
    desiredConnected: currentState.desiredConnected,
    controlledTabId: normalizeTabId(currentState.controlledTabId),
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
    connecting: Boolean(socket && socket.readyState === WebSocket.CONNECTING) || currentState.connecting,
    reconnectAttempt: currentState.reconnectAttempt,
    lastError: currentState.lastError,
  };
}

async function executeCommand(command, payload) {
  switch (command) {
  case "tabs":
    return getTabs();
  case "state":
    return getBrowserState();
  case "open":
    return openUrl(payload);
  case "snapshot":
    return snapshotTab(await getControlledTabId(), payload);
  case "click":
    return runTargetedCommand(await getControlledTabId(), "click", payload);
  case "type":
    return runTargetedCommand(await getControlledTabId(), "type", payload);
  case "press":
    return runTargetedCommand(await getControlledTabId(), "press", payload);
  case "playMedia":
    return runTargetedCommand(await getControlledTabId(), "playMedia", payload);
  case "mediaState":
    return runTargetedCommand(await getControlledTabId(), "mediaState", payload);
  case "switchTab":
    return switchTab(payload);
  case "closeTab":
    return closeTab(payload);
  default:
    throw new Error(`Unsupported command: ${command}`);
  }
}

async function getControlledTabId() {
  const tab = await getControlledTab();
  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error("No Browser Use controlled tab. Call browser_use_open to create one, or browser_use_tabs then browser_use_switch_tab to select an existing non-OpenAgent tab.");
  }
  return tab.id;
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return null;
  }
  return callbackApi((cb) => chrome.tabs.get(tabId, cb)).catch(() => null);
}

async function getControlledTab() {
  const tabId = normalizeTabId(currentState.controlledTabId);
  if (!tabId) {
    return null;
  }
  const tab = await getTab(tabId);
  if (!tab || isProtectedTab(tab)) {
    await saveState({controlledTabId: 0});
    return null;
  }
  return tab;
}

async function setControlledTab(tab) {
  const tabId = tab && Number.isInteger(tab.id) ? tab.id : 0;
  await saveState({controlledTabId: tabId});
  return tabId;
}

async function clearControlledTab(tabId) {
  if (!tabId || normalizeTabId(currentState.controlledTabId) === tabId) {
    await saveState({controlledTabId: 0});
  }
}

async function ensureControlledTab() {
  const existing = await getControlledTab();
  if (existing) {
    return existing;
  }
  const createProperties = {active: true};
  const tab = await callbackApi((cb) => chrome.tabs.create(createProperties, cb));
  if (!tab || !tab.id) {
    throw new Error("Chrome did not create a Browser Use controlled tab");
  }
  await setControlledTab(tab);
  return tab;
}

function isProtectedTab(tab) {
  return isProtectedUrl(tab && tab.url ? tab.url : "");
}

function isProtectedUrl(rawUrl) {
  if (!rawUrl) {
    return false;
  }
  let tabUrl;
  try {
    tabUrl = new URL(rawUrl);
  } catch (error) {
    return true;
  }
  if (["chrome:", "chrome-extension:", "chrome-untrusted:", "edge:", "brave:", "devtools:", "about:", "view-source:"].includes(tabUrl.protocol)) {
    return true;
  }
  let serverUrl;
  try {
    serverUrl = normalizeHttpUrl(currentState.serverUrl);
  } catch (error) {
    return false;
  }
  if (tabUrl.origin === serverUrl.origin) {
    return true;
  }
  if (!isLoopbackHost(tabUrl.hostname) || !isLoopbackHost(serverUrl.hostname)) {
    return false;
  }
  const tabPort = effectivePort(tabUrl);
  const serverPort = effectivePort(serverUrl);
  return tabUrl.protocol === serverUrl.protocol && tabPort === serverPort;
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function effectivePort(url) {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

async function getTabs() {
  const windows = await callbackApi((cb) => chrome.windows.getAll({populate: true}, cb));
  const controlled = await getControlledTab();
  const tabs = [];
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      tabs.push(normalizeTab(tab, Boolean(win.focused && tab.active), controlled && tab.id === controlled.id));
    }
  }
  tabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
  return {
    tabs,
  };
}

function normalizeTab(tab, active, controlled) {
  return {
    id: tab.id || 0,
    windowId: tab.windowId || 0,
    index: tab.index || 0,
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(active),
    controlled: Boolean(controlled),
    protected: isProtectedTab(tab),
  };
}

async function getBrowserState() {
  const tabsResult = await getTabs();
  const controlledIndex = tabsResult.tabs.findIndex((tab) => tab.controlled) + 1;
  const controlled = controlledIndex > 0 ? tabsResult.tabs[controlledIndex - 1] : {};
  let mediaState = "none";
  if (controlled.id) {
    try {
      const media = await runTargetedCommand(controlled.id, "mediaState", {});
      mediaState = media && media.text ? media.text : "none";
    } catch (error) {
      mediaState = `unavailable: ${error.message}`;
    }
  }
  return {
    mode: "OpenAgent Chrome Extension (Experimental)",
    connected: true,
    name: "openagent-browser-bridge",
    version: chrome.runtime.getManifest().version,
    tab: controlled,
    tabCount: tabsResult.tabs.length,
    controlledIndex: controlledIndex > 0 ? controlledIndex : 0,
    mediaState,
  };
}

async function openUrl(payload) {
  const url = payload && payload.url ? String(payload.url) : "";
  if (!url) {
    throw new Error("Missing URL");
  }
  if (isProtectedUrl(url)) {
    throw new Error("OpenAgent control tab is protected; Browser Use will open or switch to a separate controlled tab.");
  }

  const controlled = await ensureControlledTab();
  const tab = await callbackApi((cb) => chrome.tabs.update(controlled.id, {url, active: true}, cb));
  await setControlledTab(tab);
  if (!tab || !tab.id) {
    throw new Error("Chrome did not return a tab for navigation");
  }
  await waitForTabComplete(tab.id);
  await settleTab(tab.id);
  const updated = await callbackApi((cb) => chrome.tabs.get(tab.id, cb));
  await setControlledTab(updated);
  return {tab: normalizeTab(updated, updated.active, true)};
}

async function switchTab(payload) {
  const tabId = Number(payload && payload.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("Missing tabId");
  }
  const target = await getTab(tabId);
  if (!target) {
    throw new Error(`Chrome tab ${tabId} was not found`);
  }
  if (isProtectedTab(target)) {
    throw new Error("OpenAgent control tab is protected; Browser Use will open or switch to a separate controlled tab.");
  }
  const tab = await callbackApi((cb) => chrome.tabs.update(tabId, {active: true}, cb));
  if (tab.windowId) {
    await callbackApi((cb) => chrome.windows.update(tab.windowId, {focused: true}, cb));
  }
  await setControlledTab(tab);
  return {tab: normalizeTab(tab, true, true)};
}

async function closeTab(payload) {
  const tabId = Number(payload && payload.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("Missing tabId");
  }
  const tab = await getTab(tabId);
  if (tab && isProtectedTab(tab)) {
    throw new Error("OpenAgent control tab is protected; Browser Use will open or switch to a separate controlled tab.");
  }
  await callbackApi((cb) => chrome.tabs.remove(tabId, cb));
  snapshotTargetsByTab.delete(tabId);
  await clearControlledTab(tabId);
  return {closed: true, tabId};
}

async function waitForTabComplete(tabId) {
  if (!tabId) {
    return;
  }
  const tab = await callbackApi((cb) => chrome.tabs.get(tabId, cb)).catch(() => null);
  if (tab && tab.status === "complete") {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(done, 15000);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        done();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function settleTab(tabId) {
  await new Promise((resolve) => setTimeout(resolve, 350));
  const tab = await callbackApi((cb) => chrome.tabs.get(tabId, cb)).catch(() => null);
  if (tab && tab.status === "loading") {
    await waitForTabComplete(tabId);
  }
}

async function ensureContentScript(tabId, allFrames) {
  await callbackApi((cb) => chrome.scripting.executeScript({
    target: {tabId, allFrames: Boolean(allFrames)},
    files: ["content.js"],
  }, cb));
}

async function getFrames(tabId) {
  try {
    const frames = await callbackApi((cb) => chrome.webNavigation.getAllFrames({tabId}, cb));
    if (frames && frames.length > 0) {
      return frames.sort((a, b) => a.frameId - b.frameId);
    }
  } catch (error) {
    // webNavigation is best-effort; fall back to the main frame.
  }
  return [{frameId: 0, url: ""}];
}

async function sendContentMessage(tabId, frameId, command, payload) {
  const options = Number.isInteger(frameId) ? {frameId} : undefined;
  const message = {
    type: "casibase-command",
    command,
    payload,
  };
  const response = await callbackApi((cb) => {
    if (options) {
      chrome.tabs.sendMessage(tabId, message, options, cb);
    } else {
      chrome.tabs.sendMessage(tabId, message, cb);
    }
  });
  if (response && response.error) {
    throw new Error(response.error);
  }
  return response;
}

async function snapshotTab(tabId, payload) {
  try {
    await ensureContentScript(tabId, true);
  } catch (error) {
    await ensureContentScript(tabId, false);
  }
  const tab = await callbackApi((cb) => chrome.tabs.get(tabId, cb));
  const frames = await getFrames(tabId);
  const frameResults = [];
  for (const frame of frames) {
    try {
      const result = await sendContentMessage(tabId, frame.frameId, "snapshot", {
        ...payload,
        frameId: frame.frameId,
        frameUrl: frame.url || "",
      });
      if (result) {
        frameResults.push({frame, result});
      }
    } catch (error) {
      if (frame.frameId === 0) {
        throw error;
      }
      frameResults.push({
        frame,
        result: {
          url: frame.url || "",
          title: "",
          visibleText: "",
          mediaState: "",
          elements: [],
          warning: error.message || String(error),
        },
      });
    }
  }

  const main = frameResults.find((item) => item.frame.frameId === 0) || frameResults[0] || {};
  const elements = [];
  const indexMap = new Map();
  let nextIndex = 1;
  for (const item of frameResults) {
    const result = item.result || {};
    for (const element of result.elements || []) {
      if (nextIndex > 180) {
        break;
      }
      const global = {
        ...element,
        index: nextIndex,
        ref: element.ref || String(element.index || nextIndex),
        frameId: item.frame.frameId,
        frameUrl: item.frame.url || result.url || "",
      };
      elements.push(global);
      indexMap.set(nextIndex, {
        frameId: item.frame.frameId,
        ref: global.ref,
      });
      nextIndex += 1;
    }
  }
  snapshotTargetsByTab.set(tabId, indexMap);

  const visibleTextParts = [];
  for (const item of frameResults) {
    const result = item.result || {};
    const text = (result.visibleText || "").trim();
    if (!text) {
      continue;
    }
    if (item.frame.frameId === 0) {
      visibleTextParts.push(text);
    } else {
      visibleTextParts.push(`[frame ${item.frame.frameId} ${item.frame.url || ""}]\n${text}`);
    }
  }

  return {
    tab: normalizeTab(tab, Boolean(tab.active), true),
    url: main.result && main.result.url ? main.result.url : tab.url || "",
    title: main.result && main.result.title ? main.result.title : tab.title || "",
    visibleText: visibleTextParts.join("\n\n").slice(0, 8000),
    mediaState: main.result && main.result.mediaState ? main.result.mediaState : "none",
    elements,
    frameCount: frameResults.length,
  };
}

async function runTargetedCommand(tabId, command, payload) {
  try {
    await ensureContentScript(tabId, command === "playMedia" || command === "mediaState");
  } catch (error) {
    await ensureContentScript(tabId, false);
  }

  const target = resolveSnapshotTarget(tabId, payload);
  const framedPayload = {...payload};
  if (target) {
    framedPayload.ref = target.ref;
    delete framedPayload.index;
  }

  const frameId = target && Number.isInteger(target.frameId) ? target.frameId : undefined;
  if (frameId !== undefined || command === "playMedia" || command === "mediaState") {
    const result = await sendContentMessage(tabId, frameId, command, framedPayload);
    if (["click", "type", "press"].includes(command)) {
      await settleTab(tabId);
    }
    return result;
  }

  try {
    const result = await sendContentMessage(tabId, 0, command, framedPayload);
    if (["click", "type", "press"].includes(command)) {
      await settleTab(tabId);
    }
    return result;
  } catch (firstError) {
    if (!payload || !payload.selector) {
      throw firstError;
    }
    const frames = await getFrames(tabId);
    for (const frame of frames) {
      if (frame.frameId === 0) {
        continue;
      }
      try {
        const result = await sendContentMessage(tabId, frame.frameId, command, framedPayload);
        if (["click", "type", "press"].includes(command)) {
          await settleTab(tabId);
        }
        return result;
      } catch (error) {
        // Try the next frame.
      }
    }
    throw firstError;
  }
}

function resolveSnapshotTarget(tabId, payload) {
  if (!payload || !payload.index) {
    return null;
  }
  const indexMap = snapshotTargetsByTab.get(tabId);
  const index = Number(payload.index);
  if (!indexMap || !indexMap.has(index)) {
    throw new Error(`Element index ${index} was not found. Call browser_use_snapshot again before reusing indexes`);
  }
  return indexMap.get(index);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await loadState();
    if (!message || !message.type) {
      sendResponse({ok: false, error: "Missing message type"});
      return;
    }
    if (message.type === "connect") {
      await connect(message.serverUrl, message.token);
      sendResponse({ok: true, state: getStatus()});
      return;
    }
    if (message.type === "disconnect") {
      await disconnect();
      sendResponse({ok: true, state: getStatus()});
      return;
    }
    if (message.type === "status") {
      sendResponse({ok: true, state: getStatus()});
      return;
    }
    sendResponse({ok: false, error: `Unsupported popup message: ${message.type}`});
  })().catch((error) => {
    currentState.lastError = error && error.message ? error.message : String(error);
    broadcastStatus();
    sendResponse({ok: false, error: currentState.lastError, state: getStatus()});
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  snapshotTargetsByTab.delete(tabId);
  clearControlledTab(tabId).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) {
    return;
  }
  loadState().then(() => {
    if (!currentState.desiredConnected) {
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendHeartbeat();
    } else if (!socket) {
      openSocket();
    }
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  loadState().then(() => {
    if (currentState.desiredConnected) {
      openSocket();
    }
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, {periodInMinutes: 1});
});

chrome.alarms.create(KEEPALIVE_ALARM, {periodInMinutes: 1});
loadState().then(() => {
  if (currentState.desiredConnected) {
    openSocket();
  }
}).catch(() => {});
