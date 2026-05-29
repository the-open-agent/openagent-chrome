const BRIDGE_PATH = "/api/chrome-connect";
const DEFAULT_SERVER_URL = "http://127.0.0.1:14000";
const HEARTBEAT_MS = 20000;
const PONG_TIMEOUT_MS = 45000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const KEEPALIVE_ALARM = "openagent-bridge-keepalive";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const MAX_SNAPSHOT_ELEMENTS = 180;
const MAX_CDP_ELEMENTS = 60;
const MAX_AX_LINES = 120;
const MAX_DOM_TEXT_CHARS = 4000;

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
  case "resolveClickPoint":
    return resolveClickPoint(await getControlledTabId(), payload);
  case "afterNativeClick":
    return afterNativeClick(payload);
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

async function ensureControlledTab(url) {
  const existing = await getControlledTab();
  if (existing) {
    return existing;
  }
  const createProperties = {active: false};
  if (url) {
    createProperties.url = url;
  }
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

  const controlled = await getControlledTab();
  const tab = controlled
    ? await callbackApi((cb) => chrome.tabs.update(controlled.id, {url}, cb))
    : await ensureControlledTab(url);
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

function isMainFrame(frameId) {
  return !Number.isInteger(frameId) || frameId === 0;
}

async function ensureContentScriptInFrame(tabId, frameId) {
  if (isMainFrame(frameId)) {
    await ensureContentScript(tabId, false);
    return;
  }
  await callbackApi((cb) => chrome.scripting.executeScript({
    target: {tabId, frameIds: [frameId]},
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
    console.warn(`getFrames failed for tab ${tabId}: ${errorMessage(error)}`);
  }
  return [{frameId: 0, url: ""}];
}

async function sendContentMessage(tabId, frameId, command, payload) {
  const options = Number.isInteger(frameId) ? {frameId} : undefined;
  const message = {
    type: "openagent-command",
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

function isMissingContentReceiverError(error) {
  if (!error) {
    return false;
  }
  if (/Receiving end does not exist/i.test(errorMessage(error))) {
    return true;
  }
  return isMissingContentReceiverError(error.cause);
}

async function sendContentMessageWithInjectedFrame(tabId, frameId, command, payload) {
  try {
    return await sendContentMessage(tabId, frameId, command, payload);
  } catch (error) {
    if (!isMissingContentReceiverError(error)) {
      throw error;
    }
    try {
      await ensureContentScriptInFrame(tabId, frameId);
    } catch (injectError) {
      const reinjectError = new Error(
        `Content script receiver was missing in frame ${isMainFrame(frameId) ? 0 : frameId}, ` +
        `and reinjection failed: ${errorMessage(injectError)}`
      );
      reinjectError.cause = error;
      throw reinjectError;
    }
    return sendContentMessage(tabId, frameId, command, payload);
  }
}

async function snapshotTab(tabId, payload) {
  const contentSnapshot = await collectContentSnapshot(tabId, payload);
  const cdpSnapshot = await collectCdpSnapshot(tabId);
  return normalizeSnapshot(tabId, contentSnapshot, cdpSnapshot);
}

async function collectContentSnapshot(tabId, payload) {
  await ensureContentScript(tabId, true);
  const tab = await callbackApi((cb) => chrome.tabs.get(tabId, cb));
  const frames = await getFrames(tabId);
  const frameResults = [];
  for (const frame of frames) {
    let result;
    try {
      result = await sendContentMessageWithInjectedFrame(tabId, frame.frameId, "snapshot", {
        ...payload,
        frameId: frame.frameId,
        frameUrl: frame.url || "",
      });
    } catch (error) {
      if (isMainFrame(frame.frameId) || !isMissingContentReceiverError(error)) {
        throw error;
      }
      console.warn(`snapshot skipped frame ${frame.frameId} in tab ${tabId}: ${errorMessage(error)}`);
      continue;
    }
    if (result) {
      frameResults.push({frame, result});
    }
  }
  return {tab, frames, frameResults};
}

async function collectCdpSnapshot(tabId) {
  if (!chrome.debugger) {
    console.warn("Chrome debugger API is unavailable; reload the extension after granting the debugger permission.");
    return null;
  }
  const attached = await debuggerAttach(tabId);
  if (!attached) {
    return null;
  }
  try {
    const frameTree = await debuggerSendCommand(tabId, "Page.getFrameTree", {});
    const frameIds = flattenCdpFrameTree(frameTree && frameTree.frameTree).map((frame) => frame.id).filter(Boolean);
    const axTrees = [];
    for (const frameId of frameIds) {
      const axTree = await debuggerSendCommand(tabId, "Accessibility.getFullAXTree", {frameId});
      axTrees.push({frameId, nodes: axTree && Array.isArray(axTree.nodes) ? axTree.nodes : []});
    }
    const domSnapshot = await debuggerSendCommand(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
      includePaintOrder: true,
      includeDOMRects: true,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    });
    const runtimeState = await evaluateCdpRuntimeState(tabId);
    return {frameTree, frameIds, axTrees, domSnapshot, runtimeState};
  } finally {
    await debuggerDetach(tabId);
  }
}

async function debuggerAttach(tabId) {
  try {
    await callbackApi((cb) => chrome.debugger.attach({tabId}, DEBUGGER_PROTOCOL_VERSION, cb));
    return true;
  } catch (error) {
    // DevTools or another debugger is already attached; skip CDP for this snapshot.
    console.warn(`debuggerAttach failed for tab ${tabId}: ${error.message}`);
    return false;
  }
}

async function debuggerDetach(tabId) {
  await callbackApi((cb) => chrome.debugger.detach({tabId}, cb)).catch(() => {});
}

async function debuggerSendCommand(tabId, method, params) {
  return callbackApi((cb) => chrome.debugger.sendCommand({tabId}, method, params || {}, cb));
}

async function evaluateCdpRuntimeState(tabId) {
  const result = await debuggerSendCommand(tabId, "Runtime.evaluate", {
    expression: cdpRuntimeStateExpression(),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result && result.exceptionDetails) {
    const description = result.exceptionDetails.text ||
      result.exceptionDetails.exception && result.exceptionDetails.exception.description ||
      "Runtime.evaluate failed";
    throw new Error(description);
  }
  return result && result.result ? result.result.value || null : null;
}

function flattenCdpFrameTree(frameTree) {
  if (!frameTree || !frameTree.frame) {
    return [];
  }
  const frames = [frameTree.frame];
  for (const child of frameTree.childFrames || []) {
    frames.push(...flattenCdpFrameTree(child));
  }
  return frames;
}

function normalizeSnapshot(tabId, contentSnapshot, cdpSnapshot) {
  const {tab, frameResults} = contentSnapshot;
  const main = frameResults.find((item) => item.frame.frameId === 0) || frameResults[0] || {};
  const contentElements = collectContentElements(frameResults);
  const cdpDetails = normalizeCdpSnapshot(cdpSnapshot);
  const merged = mergeSnapshotElements(contentElements, cdpDetails.elements);
  const elements = [];
  const indexMap = new Map();
  let nextIndex = 1;
  for (const item of merged) {
    if (nextIndex > MAX_SNAPSHOT_ELEMENTS) {
      break;
    }
    elements.push({...item.element, index: nextIndex});
    indexMap.set(nextIndex, item.target);
    nextIndex += 1;
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
  const semanticText = formatSemanticText(contentSnapshot, cdpDetails);
  if (semanticText) {
    visibleTextParts.push(semanticText);
  }

  return {
    tab: normalizeTab(tab, Boolean(tab.active), true),
    url: main.result && main.result.url ? main.result.url : tab.url || "",
    title: main.result && main.result.title ? main.result.title : tab.title || "",
    visibleText: visibleTextParts.join("\n\n").slice(0, 16000),
    mediaState: main.result && main.result.mediaState ? main.result.mediaState : "none",
    elements,
    frameCount: frameResults.length,
  };
}

function collectContentElements(frameResults) {
  const items = [];
  for (const item of frameResults) {
    const result = item.result || {};
    for (const element of result.elements || []) {
      const ref = element.ref || String(element.index || "");
      if (!ref) {
        continue;
      }
      items.push({
        element: {
          ...element,
          index: 0,
          ref,
          frameId: item.frame.frameId,
          frameUrl: item.frame.url || result.url || "",
        },
        target: {
          frameId: item.frame.frameId,
          ref,
        },
      });
    }
  }
  return items;
}

function mergeSnapshotElements(contentElements, cdpElements) {
  const merged = [];
  const seen = new Set();
  for (const item of [...contentElements, ...cdpElements]) {
    const key = elementDedupeKey(item.element);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function elementDedupeKey(element) {
  const text = normalizeInlineText(element.text || element.ariaLabel || element.placeholder || element.value || "").slice(0, 80);
  return [
    element.frameId || 0,
    element.tag || "",
    element.role || "",
    text,
    Math.round(Number(element.x || 0) / 4) * 4,
    Math.round(Number(element.y || 0) / 4) * 4,
    Math.round(Number(element.width || 0) / 4) * 4,
    Math.round(Number(element.height || 0) / 4) * 4,
  ].join("|");
}

function normalizeCdpSnapshot(cdpSnapshot) {
  if (!cdpSnapshot) {
    return {runtimeState: {}, axLines: [], domText: "", elements: []};
  }
  const domIndex = buildDomSnapshotIndex(cdpSnapshot.domSnapshot);
  const axSummary = buildAxSummary(cdpSnapshot.axTrees, domIndex);
  return {
    runtimeState: cdpSnapshot.runtimeState || {},
    axLines: axSummary.lines,
    domText: domIndex.textSummary,
    elements: axSummary.elements,
  };
}

function buildDomSnapshotIndex(domSnapshot) {
  const strings = Array.isArray(domSnapshot && domSnapshot.strings) ? domSnapshot.strings : [];
  const documents = Array.isArray(domSnapshot && domSnapshot.documents) ? domSnapshot.documents : [];
  const backendToNode = new Map();
  const textParts = [];

  for (let docIndex = 0; docIndex < documents.length; docIndex += 1) {
    const doc = documents[docIndex] || {};
    const nodes = doc.nodes || {};
    const layout = doc.layout || {};
    const layoutByNodeIndex = buildLayoutIndex(layout);
    const docNodes = [];
    const nodeCount = Array.isArray(nodes.nodeType) ? nodes.nodeType.length : 0;
    for (let index = 0; index < nodeCount; index += 1) {
      const layoutIndex = layoutByNodeIndex.get(index);
      const attrs = parseSnapshotAttributes(strings, nodes.attributes && nodes.attributes[index]);
      const node = {
        docIndex,
        index,
        nodeType: Number(nodes.nodeType[index] || 0),
        nodeName: snapshotString(strings, nodes.nodeName && nodes.nodeName[index]),
        nodeValue: snapshotString(strings, nodes.nodeValue && nodes.nodeValue[index]),
        backendNodeId: Number(nodes.backendNodeId && nodes.backendNodeId[index] || 0),
        parentIndex: Number.isInteger(nodes.parentIndex && nodes.parentIndex[index]) ? nodes.parentIndex[index] : -1,
        attrs,
        bounds: parseSnapshotBounds(layout, layoutIndex),
        selector: "",
      };
      docNodes[index] = node;
      if (node.backendNodeId) {
        backendToNode.set(node.backendNodeId, node);
      }
    }
    for (const node of docNodes) {
      if (node && node.nodeType === 1) {
        node.selector = buildCssPath(docNodes, node.index);
      }
      if (node && node.nodeType === 3 && node.nodeValue && isUsefulTextParent(docNodes[node.parentIndex])) {
        textParts.push(node.nodeValue);
      }
    }
  }

  return {
    backendToNode,
    textSummary: compactUniqueText(textParts.join(" "), MAX_DOM_TEXT_CHARS),
  };
}

function buildLayoutIndex(layout) {
  const map = new Map();
  for (let i = 0; i < (layout.nodeIndex || []).length; i += 1) {
    if (!map.has(layout.nodeIndex[i])) {
      map.set(layout.nodeIndex[i], i);
    }
  }
  return map;
}

function parseSnapshotAttributes(strings, rawAttributes) {
  const attrs = {};
  if (!Array.isArray(rawAttributes)) {
    return attrs;
  }
  for (let i = 0; i + 1 < rawAttributes.length; i += 2) {
    const name = snapshotString(strings, rawAttributes[i]);
    if (!name) {
      continue;
    }
    attrs[name] = snapshotString(strings, rawAttributes[i + 1]);
  }
  return attrs;
}

function parseSnapshotBounds(layout, layoutIndex) {
  if (!Number.isInteger(layoutIndex) || layoutIndex < 0 || !Array.isArray(layout.bounds) || !Array.isArray(layout.bounds[layoutIndex])) {
    return null;
  }
  const bounds = layout.bounds[layoutIndex];
  if (bounds.length < 4) {
    return null;
  }
  return {
    x: Math.round(Number(bounds[0] || 0)),
    y: Math.round(Number(bounds[1] || 0)),
    width: Math.round(Number(bounds[2] || 0)),
    height: Math.round(Number(bounds[3] || 0)),
  };
}

function snapshotString(strings, index) {
  return Number.isInteger(index) && index >= 0 && index < strings.length ? String(strings[index] || "") : "";
}

function isUsefulTextParent(parent) {
  if (!parent || parent.nodeType !== 1) {
    return false;
  }
  const name = String(parent.nodeName || "").toLowerCase();
  return !["script", "style", "noscript", "template", "svg"].includes(name);
}

function buildCssPath(docNodes, startIndex) {
  const parts = [];
  let index = startIndex;
  while (Number.isInteger(index) && index >= 0) {
    const node = docNodes[index];
    if (!node || node.nodeType !== 1) {
      break;
    }
    const tag = String(node.nodeName || "").toLowerCase();
    if (!tag || tag === "html") {
      break;
    }
    const id = node.attrs && node.attrs.id;
    if (id) {
      parts.unshift(`${tag}[id="${cssAttrLoose(id)}"]`);
      break;
    }
    const nth = nthOfType(docNodes, node);
    parts.unshift(nth > 1 ? `${tag}:nth-of-type(${nth})` : tag);
    index = node.parentIndex;
    if (parts.length >= 6) {
      break;
    }
  }
  return parts.length ? parts.join(" > ") : "";
}

function nthOfType(docNodes, node) {
  let count = 0;
  for (const candidate of docNodes) {
    if (!candidate || candidate.parentIndex !== node.parentIndex || candidate.nodeType !== 1) {
      continue;
    }
    if (String(candidate.nodeName || "").toLowerCase() !== String(node.nodeName || "").toLowerCase()) {
      continue;
    }
    count += 1;
    if (candidate.index === node.index) {
      return count;
    }
  }
  return 1;
}

function buildAxSummary(axTrees, domIndex) {
  const lines = [];
  const elements = [];
  const seenElements = new Set();
  for (const tree of axTrees || []) {
    const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
    for (const node of nodes) {
      if (!node || node.ignored) {
        continue;
      }
      const role = axValue(node.role);
      const name = normalizeInlineText(axValue(node.name));
      const value = normalizeInlineText(axValue(node.value));
      const description = normalizeInlineText(axValue(node.description));
      if (!role && !name && !value) {
        continue;
      }
      if (lines.length < MAX_AX_LINES) {
        lines.push(formatAxLine(role, name, value, description));
      }
      if (elements.length >= MAX_CDP_ELEMENTS || !isInteractiveAxRole(role)) {
        continue;
      }
      const backendNodeId = Number(node.backendDOMNodeId || node.backendNodeId || 0);
      const domNode = backendNodeId ? domIndex.backendToNode.get(backendNodeId) : null;
      if (!domNode || domNode.docIndex !== 0 || !domNode.selector || !domNode.bounds || domNode.bounds.width <= 0 || domNode.bounds.height <= 0) {
        continue;
      }
      const key = `${backendNodeId}|${role}|${name}|${value}`;
      if (seenElements.has(key)) {
        continue;
      }
      seenElements.add(key);
      elements.push({
        element: {
          index: 0,
          ref: `cdp-${backendNodeId}`,
          frameId: 0,
          frameUrl: "",
          tag: String(domNode.nodeName || "").toLowerCase(),
          text: name || value || description,
          ariaLabel: domNode.attrs["aria-label"] || "",
          placeholder: domNode.attrs.placeholder || "",
          value: value || domNode.attrs.value || "",
          options: [],
          href: domNode.attrs.href || "",
          role,
          x: domNode.bounds.x,
          y: domNode.bounds.y,
          width: domNode.bounds.width,
          height: domNode.bounds.height,
        },
        target: {
          frameId: 0,
          selector: domNode.selector,
        },
      });
    }
  }
  return {lines, elements};
}

function axValue(raw) {
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  if (typeof raw === "object" && raw.value !== undefined && raw.value !== null) {
    return String(raw.value);
  }
  return "";
}

function formatAxLine(role, name, value, description) {
  let line = `- ${role || "node"}`;
  if (name) {
    line += ` "${name.slice(0, 160)}"`;
  }
  if (value && value !== name) {
    line += ` value="${value.slice(0, 120)}"`;
  }
  if (description && description !== name && description !== value) {
    line += ` description="${description.slice(0, 120)}"`;
  }
  return line;
}

function isInteractiveAxRole(role) {
  return [
    "button", "link", "menuitem", "option", "tab", "checkbox", "radio", "switch",
    "textbox", "combobox", "searchbox", "slider", "spinbutton", "listbox",
  ].includes(String(role || "").toLowerCase());
}

function formatSemanticText(contentSnapshot, cdpDetails) {
  const lines = ["Enhanced semantic snapshot:"];
  const runtime = cdpDetails.runtimeState || {};
  lines.push(formatFocusBlock("CDP focus", runtime.focus));
  lines.push(formatSelectionBlock("CDP selection", runtime.selection));
  const contentStateLines = formatContentFrameStates(contentSnapshot.frameResults);
  if (contentStateLines.length) {
    lines.push("Content script frame states:");
    lines.push(...contentStateLines);
  }
  if (cdpDetails.axLines.length) {
    lines.push("Accessibility tree:");
    lines.push(...cdpDetails.axLines);
  }
  if (cdpDetails.domText) {
    lines.push("DOM text summary:");
    lines.push(cdpDetails.domText);
  }
  return lines.filter(Boolean).join("\n");
}

function formatContentFrameStates(frameResults) {
  const lines = [];
  for (const item of frameResults || []) {
    const state = item.result && item.result.pageState;
    if (!state || (!state.focus || !state.focus.present) && (!state.selection || !state.selection.present)) {
      continue;
    }
    const prefix = `[frame ${item.frame.frameId} ${item.frame.url || ""}]`;
    lines.push(`${prefix} ${formatFocusInline(state.focus)} ${formatSelectionInline(state.selection)}`.trim());
  }
  return lines.slice(0, 20);
}

function formatFocusBlock(label, focus) {
  if (!focus || !focus.present) {
    return `${label}: none`;
  }
  return `${label}: ${formatFocusInline(focus)}`;
}

function formatSelectionBlock(label, selection) {
  if (!selection || !selection.present) {
    return `${label}: none`;
  }
  return `${label}: ${formatSelectionInline(selection)}`;
}

function formatFocusInline(focus) {
  if (!focus || !focus.present) {
    return "focus=none";
  }
  const parts = [
    `focus=<${focus.tag || ""}>`,
    focus.role ? `role=${focus.role}` : "",
    focus.contenteditable ? "contenteditable=true" : "",
    focus.text ? `text="${normalizeInlineText(focus.text).slice(0, 180)}"` : "",
    focus.value ? `value="${normalizeInlineText(focus.value).slice(0, 120)}"` : "",
    Number.isFinite(focus.x) ? `rect=(${focus.x},${focus.y},${focus.width},${focus.height})` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function formatSelectionInline(selection) {
  if (!selection || !selection.present) {
    return "selection=none";
  }
  const parts = [
    `selection=${selection.collapsed ? "collapsed" : "range"}`,
    selection.kind ? `kind=${selection.kind}` : "",
    selection.text ? `text="${normalizeInlineText(selection.text).slice(0, 240)}"` : "",
    Number.isInteger(selection.start) && Number.isInteger(selection.end) ? `range=${selection.start}-${selection.end}` : "",
    Number.isFinite(selection.x) ? `rect=(${selection.x},${selection.y},${selection.width},${selection.height})` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function compactUniqueText(text, maxChars) {
  const parts = normalizeInlineText(text).split(" ");
  const out = [];
  let last = "";
  let length = 0;
  for (const part of parts) {
    if (!part || part === last) {
      continue;
    }
    const nextLength = length + part.length + (out.length ? 1 : 0);
    if (nextLength > maxChars) {
      if (out.length === 0) {
        out.push(part.slice(0, maxChars));
      }
      break;
    }
    out.push(part);
    last = part;
    length = nextLength;
  }
  return out.join(" ");
}

function normalizeInlineText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function cssAttrLoose(value) {
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function cdpRuntimeStateExpression() {
  return `(() => {
    const normalizeText = (value, limit = 500) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, limit);
    const rectObject = (rect) => rect ? {
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0)
    } : {};
    const tagName = (el) => el && el.tagName ? el.tagName.toLowerCase() : "";
    const deepActiveElement = (root) => {
      let active = root && root.activeElement ? root.activeElement : null;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const valueText = (el) => {
      if (!el) return "";
      const tag = tagName(el);
      if (tag === "input") {
        const type = (el.type || "text").toLowerCase();
        if (["password", "file"].includes(type)) return "";
      }
      return typeof el.value === "string" ? el.value : "";
    };
    const accessibleText = (el) => {
      if (!el) return "";
      return normalizeText([
        el.getAttribute && el.getAttribute("aria-label"),
        el.getAttribute && el.getAttribute("title"),
        el.getAttribute && el.getAttribute("placeholder"),
        valueText(el),
        el.innerText,
        el.textContent
      ].filter(Boolean).join(" "), 800);
    };
    const active = deepActiveElement(document);
    const activeTag = tagName(active);
    let focus = {present: false};
    if (active && active !== document.body && active !== document.documentElement) {
      const rect = active.getBoundingClientRect();
      focus = {
        present: true,
        tag: activeTag,
        role: active.getAttribute("role") || "",
        text: accessibleText(active),
        ariaLabel: active.getAttribute("aria-label") || "",
        placeholder: active.getAttribute("placeholder") || "",
        value: normalizeText(valueText(active), 500),
        contenteditable: Boolean(active.isContentEditable || active.getAttribute("contenteditable") === "true"),
        ...rectObject(rect)
      };
      if ((activeTag === "input" || activeTag === "textarea") && typeof active.value === "string") {
        try {
          focus.selectionStart = active.selectionStart;
          focus.selectionEnd = active.selectionEnd;
          focus.selectedText = active.value.slice(active.selectionStart || 0, active.selectionEnd || 0).slice(0, 500);
        } catch (error) {}
      }
    }
    let selection = {present: false};
    if (active && (activeTag === "input" || activeTag === "textarea") && typeof active.value === "string") {
      try {
        const start = active.selectionStart || 0;
        const end = active.selectionEnd || start;
        selection = {
          present: true,
          kind: activeTag,
          collapsed: start === end,
          text: active.value.slice(start, end).slice(0, 1000),
          start,
          end
        };
      } catch (error) {}
    }
    if (!selection.present && window.getSelection) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        selection = {
          present: true,
          kind: "range",
          collapsed: sel.isCollapsed,
          text: sel.toString().slice(0, 1000),
          anchorText: normalizeText(sel.anchorNode && (sel.anchorNode.nodeValue || sel.anchorNode.textContent), 240),
          focusText: normalizeText(sel.focusNode && (sel.focusNode.nodeValue || sel.focusNode.textContent), 240),
          ...rectObject(range.getBoundingClientRect())
        };
      }
    }
    return {
      url: location.href,
      title: document.title,
      devicePixelRatio: window.devicePixelRatio || 1,
      focus,
      selection
    };
  })()`;
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
    if (target.selector) {
      framedPayload.selector = target.selector;
      delete framedPayload.ref;
    } else {
      framedPayload.ref = target.ref;
    }
    delete framedPayload.index;
  }

  const frameId = target && Number.isInteger(target.frameId) ? target.frameId : undefined;
  if (frameId !== undefined || command === "playMedia" || command === "mediaState") {
    return sendTargetedContentMessage(tabId, frameId, command, framedPayload);
  }

  try {
    return await sendTargetedContentMessage(tabId, 0, command, framedPayload);
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
        return await sendTargetedContentMessage(tabId, frame.frameId, command, framedPayload);
      } catch (error) {
        // Try the next frame.
      }
    }
    throw firstError;
  }
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

async function sendTargetedContentMessage(tabId, frameId, command, payload) {
  try {
    const result = await sendContentMessageWithInjectedFrame(tabId, frameId, command, payload);
    if (["click", "type", "press"].includes(command)) {
      await settleTab(tabId);
    }
    return result;
  } catch (error) {
    if (isNavigationInterruptedMessage(error) && canCommandNavigate(command)) {
      await settleTab(tabId);
      return {ok: true, navigationInterruptedResponse: true};
    }
    throw error;
  }
}

function isNavigationInterruptedMessage(error) {
  return /message channel closed|receiving end does not exist/i.test(errorMessage(error));
}

function canCommandNavigate(command) {
  return command === "click" || command === "press";
}

async function resolveClickPoint(tabId, payload) {
  await ensureContentScript(tabId, false);
  const target = resolveSnapshotTarget(tabId, payload);
  if (target && target.frameId !== 0) {
    throw new Error("Native click currently supports main-frame elements only. Use browser_use_click without OPENAGENT_BROWSER_USE_NATIVE_CLICK for iframe targets.");
  }

  const tab = await callbackApi((cb) => chrome.tabs.update(tabId, {active: true}, cb));
  if (tab.windowId) {
    await callbackApi((cb) => chrome.windows.update(tab.windowId, {focused: true}, cb));
  }
  await sleep(120);

  const framedPayload = {...payload};
  if (target) {
    if (target.selector) {
      framedPayload.selector = target.selector;
      delete framedPayload.ref;
    } else {
      framedPayload.ref = target.ref;
    }
    delete framedPayload.index;
  }
  const point = await sendContentMessage(tabId, 0, "resolveClickPoint", framedPayload);
  return {
    ...point,
    tabId,
    windowId: tab.windowId || 0,
  };
}

async function afterNativeClick(payload) {
  const originalTabId = normalizeTabId(payload && payload.tabId);
  if (originalTabId) {
    await settleTab(originalTabId).catch(() => {});
  }
  await sleep(350);

  const activeTab = await getActiveNonProtectedTab(Number(payload && payload.windowId) || 0);
  if (activeTab) {
    await settleTab(activeTab.id).catch(() => {});
    const updated = await callbackApi((cb) => chrome.tabs.get(activeTab.id, cb)).catch(() => activeTab);
    await setControlledTab(updated);
    return {tab: normalizeTab(updated, true, true)};
  }

  const controlled = await getControlledTab();
  if (controlled) {
    return {tab: normalizeTab(controlled, Boolean(controlled.active), true)};
  }
  return {ok: true};
}

async function getActiveNonProtectedTab(preferredWindowId) {
  const windows = await callbackApi((cb) => chrome.windows.getAll({populate: true}, cb));
  const ordered = [...windows].sort((a, b) => {
    if (preferredWindowId && a.id === preferredWindowId) {
      return -1;
    }
    if (preferredWindowId && b.id === preferredWindowId) {
      return 1;
    }
    return Number(Boolean(b.focused)) - Number(Boolean(a.focused));
  });
  for (const win of ordered) {
    const active = (win.tabs || []).find((tab) => tab.active && !isProtectedTab(tab));
    if (active) {
      return active;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
