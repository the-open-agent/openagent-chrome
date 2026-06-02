const stepsEl = document.getElementById("steps");
const summaryText = document.getElementById("summaryText");
const refreshButton = document.getElementById("refresh");
const playButton = document.getElementById("play");
const saveButton = document.getElementById("saveOpenAgent");
const deleteButton = document.getElementById("deleteOpenAgent");
const actionGroupInput = document.getElementById("actionGroup");
const actionNameInput = document.getElementById("actionName");
const actionDescriptionInput = document.getElementById("actionDescription");
const saveStatus = document.getElementById("saveStatus");

let recording = {steps: []};
let editableSteps = [];
let draggedStepIndex = -1;

function send(message) {
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

function isVariablePlaceholder(value) {
  return /^\s*\{\{\s*[\w.-]+\s*\}\}\s*$/.test(String(value || ""));
}

function normalizeIdentifier(value, fallback) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return text || fallback;
}

function firstRecordedUrl() {
  if (recording.startUrl) {
    return recording.startUrl;
  }
  if (recording.lastUrl) {
    return recording.lastUrl;
  }
  const step = (recording.steps || []).find((item) => item && item.url);
  return step && step.url || "";
}

function defaultActionGroup() {
  try {
    const url = new URL(firstRecordedUrl());
    return normalizeIdentifier(url.hostname.replace(/^www\./, ""), "site");
  } catch (error) {
    return "site";
  }
}

function defaultActionName() {
  const kinds = (recording.steps || []).map((step) => step && step.kind).filter(Boolean);
  if (kinds.includes("type") && kinds.includes("click")) {
    return "recorded_form_flow";
  }
  if (kinds.includes("navigate")) {
    return "recorded_navigation";
  }
  return "recorded_action";
}

function setSaveStatus(message, className = "") {
  saveStatus.textContent = message;
  saveStatus.className = `save-status ${className}`.trim();
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function toReplayStep(step, options = {}) {
  if (step.kind === "navigate" || step.kind === "open") {
    return {
      kind: "open",
      url: step.url || "",
    };
  }
  if (step.kind === "press") {
    return {
      kind: "press",
      key: step.key || "",
    };
  }
  if (step.kind === "drag_and_drop") {
    return {
      kind: "drag_and_drop",
      sourceSelector: step.sourceSelector || step.source && step.source.selector || "",
      targetSelector: step.targetSelector || step.target && step.target.selector || "",
    };
  }
  const mode = step.selectorMode || "css";
  const base = {
    kind: step.kind === "dblclick" ? "click" : step.kind || "click",
  };
  if (step.selector && mode !== "position") {
    base.selector = step.selector;
  }
  const x = firstPresent(step.x, step.fallback && step.fallback.x);
  const y = firstPresent(step.y, step.fallback && step.fallback.y);
  if (mode === "position" || x !== undefined || y !== undefined) {
    base.x = Number(x ?? 0);
    base.y = Number(y ?? 0);
  }
  if (step.kind === "dblclick") {
    base.doubleClick = true;
  }
  if (step.doubleClick) {
    base.doubleClick = true;
  }
  for (const key of ["button", "ctrlKey", "shiftKey", "altKey", "metaKey"]) {
    if (step[key] !== undefined) {
      base[key] = step[key];
    }
  }
  if (step.kind === "type") {
    base.text = options.useOriginalVariables && isVariablePlaceholder(step.text) && step.value !== undefined
      ? String(step.value || "")
      : step.text || "";
    base.clear = step.clear !== false;
  }
  return base;
}

function replaySteps(options = {}) {
  return editableSteps.map((step) => toReplayStep(step, options)).filter((step) => step.kind);
}

function updateStep(index, patch, shouldRender = true) {
  editableSteps[index] = {...editableSteps[index], ...patch};
  if (shouldRender) {
    render();
  }
}

function removeStep(index) {
  editableSteps.splice(index, 1);
  render();
}

function moveStep(from, to) {
  if (from === to || from < 0 || to < 0 || from >= editableSteps.length || to >= editableSteps.length) {
    return;
  }
  const [step] = editableSteps.splice(from, 1);
  editableSteps.splice(to, 0, step);
  render();
}

function defaultStep(kind) {
  switch (kind) {
  case "open":
    return {kind: "open", url: firstRecordedUrl() || "https://example.com/"};
  case "type":
    return {kind: "type", selectorMode: "css", selector: "", text: "{{value}}", clear: true};
  case "press":
    return {kind: "press", key: "Enter"};
  case "drag_and_drop":
    return {kind: "drag_and_drop", sourceSelector: "", targetSelector: ""};
  case "click":
  default:
    return {kind: "click", selectorMode: "css", selector: ""};
  }
}

function addStep(kind) {
  editableSteps.push(defaultStep(kind));
  render();
}

function input(label, value, onInput, className = "") {
  const wrap = document.createElement("label");
  if (className) {
    wrap.className = className;
  }
  wrap.textContent = label;
  const el = document.createElement("input");
  el.value = value === undefined || value === null ? "" : String(value);
  el.addEventListener("input", () => onInput(el.value));
  wrap.appendChild(el);
  return wrap;
}

function select(label, value, options, onInput) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const el = document.createElement("select");
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option;
    el.appendChild(item);
  }
  el.value = value || options[0];
  el.addEventListener("change", () => onInput(el.value));
  wrap.appendChild(el);
  return wrap;
}

function renderStep(step, index) {
  const card = document.createElement("article");
  card.className = "step-card";
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    draggedStepIndex = index;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  });
  card.addEventListener("dragend", () => {
    draggedStepIndex = -1;
    card.classList.remove("dragging");
  });
  card.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => {
    card.classList.remove("drag-over");
  });
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("drag-over");
    const from = Number(event.dataTransfer.getData("text/plain"));
    moveStep(Number.isInteger(from) ? from : draggedStepIndex, index);
  });

  const head = document.createElement("div");
  head.className = "step-head";
  const title = document.createElement("div");
  const titleLine = document.createElement("div");
  titleLine.className = "step-title";
  const dragHandle = document.createElement("span");
  dragHandle.className = "drag-handle";
  dragHandle.textContent = "Drag";
  titleLine.appendChild(dragHandle);
  titleLine.appendChild(document.createTextNode(`${index + 1}. ${step.kind || "unknown"}`));
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = step.target && step.target.text || step.url || "";
  title.append(titleLine, meta);
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => removeStep(index));
  head.append(title, remove);
  card.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.appendChild(select("Kind", step.kind, ["open", "click", "dblclick", "type", "press", "drag_and_drop", "navigate"], (value) => updateStep(index, {kind: value})));

  if (step.kind === "navigate" || step.kind === "open") {
    grid.appendChild(input("Open URL", step.url || "", (value) => updateStep(index, {url: value}, false), "wide"));
  } else if (step.kind === "press") {
    grid.appendChild(input("Key", step.key || "", (value) => updateStep(index, {key: value}, false)));
  } else if (step.kind === "drag_and_drop") {
    grid.appendChild(input("Source selector", step.sourceSelector || step.source && step.source.selector || "", (value) => updateStep(index, {sourceSelector: value}, false), "wide"));
    grid.appendChild(input("Target selector", step.targetSelector || step.target && step.target.selector || "", (value) => updateStep(index, {targetSelector: value}, false), "wide"));
  } else {
    grid.appendChild(select("Replay target", step.selectorMode || "css", ["css", "position"], (value) => updateStep(index, {selectorMode: value})));
    grid.appendChild(input("Absolute CSS selector", step.selector || "", (value) => updateStep(index, {selector: value}, false), "wide"));
    grid.appendChild(input("Position fallback X", firstPresent(step.x, step.fallback && step.fallback.x, ""), (value) => updateStep(index, {x: value}, false)));
    grid.appendChild(input("Position fallback Y", firstPresent(step.y, step.fallback && step.fallback.y, ""), (value) => updateStep(index, {y: value}, false)));
    if (step.kind === "type") {
      grid.appendChild(input("Replay text / variable", step.text || "", (value) => updateStep(index, {text: value}, false)));
      grid.appendChild(input("Original value", step.value || "", (value) => updateStep(index, {value}, false)));
    }
  }

  if (step.kind !== "navigate" && step.kind !== "open") {
    grid.appendChild(input("URL", step.url || "", (value) => updateStep(index, {url: value}, false), "wide"));
  }
  card.appendChild(grid);
  return card;
}

function render() {
  stepsEl.textContent = "";
  const replay = recording.lastReplay;
  if (replay && replay.ok) {
    summaryText.textContent = `Last replay completed: ${replay.executed || 0} step(s) executed.`;
  } else if (replay && replay.error) {
    summaryText.textContent = `Last replay failed: ${replay.error}`;
  } else {
    summaryText.textContent = `${editableSteps.length} recorded step(s). Review selectors before using this as a web action.`;
  }
  editableSteps.forEach((step, index) => {
    stepsEl.appendChild(renderStep(step, index));
  });
  if (!actionGroupInput.value) {
    actionGroupInput.value = defaultActionGroup();
  }
  if (!actionNameInput.value) {
    actionNameInput.value = defaultActionName();
  }
}

async function load() {
  const response = await send({type: "getRecording"});
  if (!response || !response.recording) {
    summaryText.textContent = response && response.error ? response.error : "No recording found.";
    return;
  }
  recording = response.recording;
  editableSteps = (recording.steps || []).map((step) => ({...step}));
  actionGroupInput.value = recording.actionGroup || "";
  actionNameInput.value = recording.actionName || "";
  actionDescriptionInput.value = recording.actionDescription || "";
  render();
}

async function playEditedSteps() {
  const steps = replaySteps({useOriginalVariables: true});
  if (steps.length === 0) {
    summaryText.textContent = "No replayable steps to play.";
    return;
  }
  playButton.disabled = true;
  playButton.textContent = "Playing...";
  summaryText.textContent = `Playing ${steps.length} step(s) on the recorded tab.`;
  try {
    const response = await send({type: "playRecording", steps});
    if (response && response.ok) {
      const executed = response.result && response.result.executed ? response.result.executed : steps.length;
      recording.steps = editableSteps.map((step) => ({...step}));
      recording.lastReplay = {ok: true, executed};
      summaryText.textContent = `Replay completed: ${executed} step(s) executed.`;
      setSaveStatus("Replay passed. You can save this action into OpenAgent.", "ok");
    } else {
      recording.lastReplay = {ok: false, error: response && response.error || "Replay failed."};
      summaryText.textContent = response && response.error ? `Replay failed: ${response.error}` : "Replay failed.";
      setSaveStatus("Replay failed. Fix the steps before saving.", "error");
    }
  } finally {
    playButton.disabled = false;
    playButton.textContent = "Play";
  }
}

async function saveToOpenAgent() {
  const steps = replaySteps();
  const actionGroup = String(actionGroupInput.value || "").trim();
  const name = String(actionNameInput.value || "").trim();
  if (!actionGroup || !name) {
    setSaveStatus("Action group and action name are required.", "error");
    return;
  }
  if (steps.length === 0) {
    setSaveStatus("No replayable steps to save.", "error");
    return;
  }

  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  setSaveStatus("Saving action to OpenAgent...");
  try {
    const response = await send({
      type: "saveWebAction",
      action: {
        action_group: actionGroup,
        name,
        url: firstRecordedUrl(),
        description: actionDescriptionInput.value || `Recorded action from ${firstRecordedUrl()}`,
        steps,
      },
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Save failed.");
    }
    const savedAction = response.result && response.result.action ? response.result.action : {
      action_group: actionGroup,
      name,
      url: firstRecordedUrl(),
      description: actionDescriptionInput.value || "",
    };
    const synced = await send({
      type: "replaceRecording",
      steps,
      startUrl: firstRecordedUrl(),
      action: savedAction,
    });
    if (synced && synced.recording) {
      recording = synced.recording;
    }
    setSaveStatus(`Saved ${actionGroup} / ${name} (${steps.length} step(s)) to OpenAgent.`, "ok");
    summaryText.textContent = `Saved ${actionGroup} / ${name}.`;
    saveButton.textContent = "Saved";
    setTimeout(() => {
      saveButton.textContent = "Save to OpenAgent";
    }, 1400);
  } catch (error) {
    setSaveStatus(`Save failed: ${error.message || String(error)}`, "error");
    summaryText.textContent = `Save failed: ${error.message || String(error)}`;
  } finally {
    saveButton.disabled = false;
    if (saveButton.textContent === "Saving...") {
      saveButton.textContent = "Save to OpenAgent";
    }
  }
}

async function deleteFromOpenAgent() {
  const actionGroup = String(actionGroupInput.value || "").trim();
  const name = String(actionNameInput.value || "").trim();
  if (!actionGroup || !name) {
    setSaveStatus("Action group and action name are required before delete.", "error");
    return;
  }
  if (!confirm(`Delete ${actionGroup} / ${name} from OpenAgent?`)) {
    return;
  }
  deleteButton.disabled = true;
  deleteButton.textContent = "Deleting...";
  try {
    const response = await send({type: "deleteWebAction", action_group: actionGroup, name});
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Delete failed.");
    }
    setSaveStatus(`Deleted ${actionGroup} / ${name} from OpenAgent.`, "ok");
  } catch (error) {
    setSaveStatus(`Delete failed: ${error.message || String(error)}`, "error");
  } finally {
    deleteButton.disabled = false;
    deleteButton.textContent = "Delete";
  }
}

refreshButton.addEventListener("click", load);
playButton.addEventListener("click", playEditedSteps);
saveButton.addEventListener("click", saveToOpenAgent);
deleteButton.addEventListener("click", deleteFromOpenAgent);
document.querySelectorAll("[data-add-step]").forEach((button) => {
  button.addEventListener("click", () => addStep(button.dataset.addStep));
});
load();
