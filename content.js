(() => {
  if (window.__openAgentBrowserBridgeContentLoaded) {
    return;
  }
  window.__openAgentBrowserBridgeContentLoaded = true;

  const maxElements = 140;
  let recorder = {
    active: false,
    sessionId: "",
    lastPointerDown: null,
    dragStart: null,
    lastInputAt: 0,
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "openagent-command") {
      return false;
    }
    try {
      const result = executeContentCommand(message.command, message.payload || {});
      if (result && typeof result.then === "function") {
        result.then(sendResponse).catch((error) => sendResponse({error: error.message || String(error)}));
        return true;
      }
      sendResponse(result);
    } catch (error) {
      sendResponse({error: error.message || String(error)});
    }
    return true;
  });

  function executeContentCommand(command, payload) {
    switch (command) {
    case "snapshot":
      return snapshot(payload);
    case "click":
      return clickElement(payload);
    case "resolveClickPoint":
      return resolveClickPoint(payload);
    case "type":
      return typeIntoElement(payload);
    case "press":
      return pressKey(payload);
    case "playMedia":
      return playMedia();
    case "mediaState":
      return {text: mediaState()};
    case "setRecorder":
      recorder.active = Boolean(payload.active);
      recorder.sessionId = payload.sessionId || recorder.sessionId || "";
      recorder.lastPointerDown = null;
      recorder.dragStart = null;
      return {recording: recorder.active};
    case "recorderState":
      return {active: recorder.active, sessionId: recorder.sessionId};
    case "showRecorderEditor":
      return showRecorderEditor();
    case "setRecorderEditorVisible":
      return setRecorderEditorVisible(payload.visible);
    case "dismissPageInterference":
      return dismissPageInterference();
    default:
      throw new Error(`Unsupported content command: ${command}`);
    }
  }

  function snapshot(payload) {
    allElements(document).forEach((el) => {
      if (el.hasAttribute("data-openagent-browser-ref")) {
        el.removeAttribute("data-openagent-browser-ref");
      }
    });

    const candidates = allElements(document)
      .filter(isVisible)
      .filter(isInteractive)
      .filter((el) => {
        const tag = tagName(el);
        return accessibleText(el) || ["input", "textarea", "select", "audio", "video"].includes(tag);
      })
      .map((el, order) => ({el, order}))
      .sort((a, b) => priorityOf(a.el) - priorityOf(b.el) || visualOrder(a.el, b.el) || a.order - b.order)
      .map((item) => item.el)
      .slice(0, maxElements);

    const elements = candidates.map((el, index) => serializeElement(el, index + 1, payload));
    const visibleText = visibleDocumentText().slice(0, 5000);
    return {
      url: window.location.href,
      title: document.title,
      visibleText,
      pageState: collectPageState(),
      mediaState: mediaState(),
      elements,
    };
  }

  function allElements(root) {
    const out = [];
    const seen = new Set();
    function visit(node) {
      if (!node || seen.has(node)) {
        return;
      }
      seen.add(node);
      if (node.nodeType === Node.ELEMENT_NODE) {
        out.push(node);
        if (node.shadowRoot) {
          visit(node.shadowRoot);
        }
      }
      const children = node.children || [];
      for (const child of children) {
        visit(child);
      }
    }
    visit(root.documentElement || root);
    return out;
  }

  function visibleDocumentText() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!text) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const parts = [];
    let node;
    while ((node = walker.nextNode()) && parts.join(" ").length < 6000) {
      parts.push(node.nodeValue.replace(/\s+/g, " ").trim());
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || el === document.documentElement || el === document.body) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (!style || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }
    if (el.getAttribute("aria-hidden") === "true" || el.hidden) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0;
  }

  function isDisabled(el) {
    return Boolean(el.disabled || el.getAttribute("aria-disabled") === "true");
  }

  function isInteractive(el) {
    if (isDisabled(el)) {
      return false;
    }
    const tag = tagName(el);
    if (["a", "button", "input", "textarea", "select", "summary", "audio", "video", "label", "option"].includes(tag)) {
      return true;
    }
    const role = (el.getAttribute("role") || "").toLowerCase();
    if ([
      "button", "link", "menuitem", "option", "tab", "checkbox", "radio", "switch",
      "textbox", "combobox", "searchbox", "slider", "spinbutton", "listbox",
    ].includes(role)) {
      return true;
    }
    if (el.hasAttribute("onclick") || el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      return true;
    }
    if (el.tabIndex >= 0) {
      return true;
    }
    const style = window.getComputedStyle(el);
    return style && style.cursor === "pointer";
  }

  function priorityOf(el) {
    const tag = tagName(el);
    if (["input", "textarea", "select"].includes(tag)) {
      return 0;
    }
    if (tag === "button") {
      return 1;
    }
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["button", "textbox", "searchbox", "combobox"].includes(role)) {
      return 2;
    }
    if (tag === "a" || role === "link") {
      return 3;
    }
    if (tag === "audio" || tag === "video") {
      return 4;
    }
    return 5;
  }

  function visualOrder(a, b) {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const y = Math.round(ar.top) - Math.round(br.top);
    if (Math.abs(y) > 8) {
      return y;
    }
    return Math.round(ar.left) - Math.round(br.left);
  }

  function tagName(el) {
    return (el && el.tagName ? el.tagName.toLowerCase() : "");
  }

  function accessibleText(el) {
    const parts = [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
      associatedLabelText(el),
      valueText(el),
      el.innerText,
      el.textContent,
    ].filter(Boolean);
    return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 220);
  }

  function associatedLabelText(el) {
    if (el.id) {
      const label = findComposed(`[for="${cssAttr(el.id)}"]`);
      if (label) {
        return label.innerText || label.textContent || "";
      }
    }
    const parentLabel = closestComposed(el, "label");
    return parentLabel ? parentLabel.innerText || parentLabel.textContent || "" : "";
  }

  function valueText(el) {
    const tag = tagName(el);
    if (tag === "select") {
      const selected = Array.from(el.selectedOptions || []).map((option) => option.text || option.value).filter(Boolean);
      return selected.join(", ");
    }
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["password", "file"].includes(type)) {
        return "";
      }
    }
    return typeof el.value === "string" ? el.value : "";
  }

  function serializeElement(el, index, payload) {
    const ref = String(index);
    const rect = el.getBoundingClientRect();
    el.setAttribute("data-openagent-browser-ref", ref);
    const tag = tagName(el);
    return {
      index,
      ref,
      frameId: payload && Number.isInteger(payload.frameId) ? payload.frameId : 0,
      frameUrl: payload && payload.frameUrl ? String(payload.frameUrl) : window.location.href,
      tag,
      text: accessibleText(el),
      ariaLabel: el.getAttribute("aria-label") || "",
      placeholder: el.getAttribute("placeholder") || "",
      value: valueText(el),
      options: tag === "select"
        ? Array.from(el.options).map((option) => (option.text || option.value || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 30)
        : [],
      href: (el.href || "").slice(0, 240),
      role: el.getAttribute("role") || "",
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function collectPageState() {
    return {
      focus: serializeFocusedElement(),
      selection: serializeSelection(),
    };
  }

  function serializeFocusedElement() {
    const el = deepActiveElement(document);
    if (!el || el === document.body || el === document.documentElement) {
      return {present: false};
    }
    const tag = tagName(el);
    const rect = el.getBoundingClientRect();
    const value = valueText(el);
    const state = {
      present: true,
      tag,
      role: el.getAttribute("role") || "",
      text: accessibleText(el).slice(0, 240),
      ariaLabel: el.getAttribute("aria-label") || "",
      placeholder: el.getAttribute("placeholder") || "",
      value,
      contenteditable: Boolean(el.isContentEditable || el.getAttribute("contenteditable") === "true"),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    if (tag === "input" || tag === "textarea") {
      const range = inputSelectionRange(el);
      state.selectionStart = range ? range.start : null;
      state.selectionEnd = range ? range.end : null;
      if (state.selectionStart !== null && state.selectionEnd !== null && typeof el.value === "string") {
        state.selectedText = el.value.slice(state.selectionStart, state.selectionEnd).slice(0, 500);
      }
    }
    return state;
  }

  function deepActiveElement(root) {
    let active = root && root.activeElement ? root.activeElement : null;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function serializeSelection() {
    const active = deepActiveElement(document);
    const tag = tagName(active);
    if ((tag === "input" || tag === "textarea") && typeof active.value === "string") {
      const range = inputSelectionRange(active) || {start: 0, end: 0};
      const start = range.start;
      const end = range.end;
      return {
        present: true,
        kind: tag,
        collapsed: start === end,
        text: active.value.slice(start, end).slice(0, 1000),
        start,
        end,
      };
    }

    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0) {
      return {present: false};
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    return {
      present: true,
      kind: "range",
      collapsed: selection.isCollapsed,
      text: selection.toString().slice(0, 1000),
      anchorText: nodeText(selection.anchorNode).slice(0, 240),
      focusText: nodeText(selection.focusNode).slice(0, 240),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function inputSelectionRange(el) {
    try {
      if (!el || !Number.isInteger(el.selectionStart) || !Number.isInteger(el.selectionEnd)) {
        return null;
      }
      return {start: el.selectionStart, end: el.selectionEnd};
    } catch (error) {
      return null;
    }
  }

  function nodeText(node) {
    if (!node) {
      return "";
    }
    return (node.nodeValue || node.textContent || "").replace(/\s+/g, " ").trim();
  }

  function resolveTarget(payload) {
    if (payload.selector) {
      const selector = String(payload.selector);
      const found = findComposed(selector);
      if (found) {
        return found;
      }
      throw new Error(`Element not found for selector: ${selector}`);
    }

    const index = payload.index || payload.ref;
    if (index) {
      const escaped = cssEscape(String(index));
      const byRef = findComposed(`[data-openagent-browser-ref="${escaped}"]`);
      if (byRef) {
        return byRef;
      }
      throw new Error(`Element index/ref ${index} was not found. Call browser_use_snapshot again before reusing indexes`);
    }
    if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      const found = document.elementFromPoint(payload.x, payload.y);
      if (found) {
        return found;
      }
      throw new Error(`Element not found at viewport position ${payload.x},${payload.y}`);
    }
    throw new Error("Missing index, ref, selector, or viewport position");
  }

  function isPositionOnlyTarget(payload) {
    return Boolean(payload) && !payload.selector && !payload.index && !payload.ref &&
      Number.isFinite(payload.x) && Number.isFinite(payload.y);
  }

  function findComposed(selector) {
    if (!selector) {
      return null;
    }
    try {
      const direct = document.querySelector(selector);
      if (direct) {
        return direct;
      }
    } catch (error) {
      return null;
    }
    return allElements(document).find((el) => {
      try {
        return el.matches(selector);
      } catch (error) {
        return false;
      }
    }) || null;
  }

  function closestComposed(el, selector) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      try {
        if (node.matches(selector)) {
          return node;
        }
      } catch (error) {
        return null;
      }
      node = node.parentElement || node.getRootNode().host;
    }
    return null;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\#.:,[\]()]/g, "\\$&");
  }

  function cssAttr(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function absoluteCssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      let part = tagName(node);
      if (!part) {
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => tagName(child) === part);
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  }

  function elementRecorderInfo(el, event) {
    const rect = el.getBoundingClientRect();
    const point = event ? {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
    } : elementCenter(el);
    return {
      selector: absoluteCssPath(el),
      selectorMode: "css",
      fallback: {
        mode: "position",
        x: point.x,
        y: point.y,
      },
      target: {
        tag: tagName(el),
        text: accessibleText(el).slice(0, 160),
        id: el.id || "",
        name: el.getAttribute("name") || "",
        role: el.getAttribute("role") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        href: el.href || "",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      },
    };
  }

  function variableNameFor(el) {
    const raw = el.getAttribute("name") || el.id || el.getAttribute("placeholder") || accessibleText(el) || "value";
    const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return normalized || "value";
  }

  function sendRecordedStep(step) {
    if (!recorder.active) {
      return;
    }
    chrome.runtime.sendMessage({
      type: "recordedStep",
      step: {
        ...step,
        sessionId: recorder.sessionId,
        url: window.location.href,
        title: document.title,
        createdAt: new Date().toISOString(),
      },
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  async function resolveClickPoint(payload) {
    const el = resolveTarget(payload);
    el.scrollIntoView({block: "center", inline: "center"});
    await sleep(80);

    const rect = el.getBoundingClientRect();
    const clientX = Number.isFinite(payload.x) ? payload.x : Math.round(rect.left + rect.width / 2);
    const clientY = Number.isFinite(payload.y) ? payload.y : Math.round(rect.top + rect.height / 2);
    const origin = viewportScreenOrigin();
    return {
      x: Math.round(origin.x + clientX),
      y: Math.round(origin.y + clientY),
      button: normalizeMouseButton(payload.button),
      frameId: Number.isInteger(payload.frameId) ? payload.frameId : 0,
      tag: tagName(el),
      text: accessibleText(el).slice(0, 120),
      clientX,
      clientY,
      viewportX: origin.x,
      viewportY: origin.y,
      screenX: Math.round(window.screenX || window.screenLeft || 0),
      screenY: Math.round(window.screenY || window.screenTop || 0),
      outerWidth: Math.round(window.outerWidth || 0),
      outerHeight: Math.round(window.outerHeight || 0),
      innerWidth: Math.round(window.innerWidth || 0),
      innerHeight: Math.round(window.innerHeight || 0),
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }

  function viewportScreenOrigin() {
    const screenX = window.screenX || window.screenLeft || 0;
    const screenY = window.screenY || window.screenTop || 0;
    const horizontalChrome = Math.max(0, (window.outerWidth || 0) - (window.innerWidth || 0));
    const verticalChrome = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));
    const sideBorder = Math.round(horizontalChrome / 2);
    return {
      x: Math.round(screenX + sideBorder),
      y: Math.round(screenY + Math.max(0, verticalChrome - sideBorder)),
    };
  }

  function normalizeMouseButton(button) {
    const value = String(button || "left").trim().toLowerCase();
    if (value === "right" || value === "middle" || value === "center") {
      return value === "center" ? "middle" : value;
    }
    return "left";
  }

  async function clickElement(payload) {
    const el = resolveTarget(payload);
    if (!isPositionOnlyTarget(payload)) {
      el.scrollIntoView({block: "center", inline: "center"});
      await sleep(80);
    }
    const rect = el.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: payload.button === "right" ? 2 : payload.button === "middle" ? 1 : 0,
      clientX: Number.isFinite(payload.x) ? payload.x : Math.round(rect.left + rect.width / 2),
      clientY: Number.isFinite(payload.y) ? payload.y : Math.round(rect.top + rect.height / 2),
      ctrlKey: Boolean(payload.ctrlKey),
      shiftKey: Boolean(payload.shiftKey),
      altKey: Boolean(payload.altKey),
      metaKey: Boolean(payload.metaKey),
    };
    el.dispatchEvent(new MouseEvent("mouseover", eventOptions));
    el.dispatchEvent(new MouseEvent("mousemove", eventOptions));
    el.dispatchEvent(new MouseEvent("mousedown", eventOptions));
    el.dispatchEvent(new MouseEvent("mouseup", eventOptions));
    if (payload.doubleClick) {
      el.dispatchEvent(new MouseEvent("dblclick", eventOptions));
    } else if (eventOptions.button === 2) {
      el.dispatchEvent(new MouseEvent("contextmenu", eventOptions));
    } else {
      el.click();
    }
    await sleep(250);
    return {clicked: true, tag: tagName(el), text: accessibleText(el).slice(0, 120)};
  }

  async function typeIntoElement(payload) {
    const el = resolveTarget(payload);
    const text = String(payload.text || "");
    const clear = payload.clear !== false;
    if (!isPositionOnlyTarget(payload)) {
      el.scrollIntoView({block: "center", inline: "center"});
      await sleep(80);
    }
    focusElement(el);

    const tag = tagName(el);
    if (tag === "select") {
      selectOption(el, text);
      return {typed: true, mode: "select"};
    }
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (["checkbox", "radio"].includes(type)) {
        setChecked(el, text, clear);
        return {typed: true, mode: type};
      }
      if (["range", "number", "date", "datetime-local", "month", "time", "week", "color"].includes(type)) {
        setNativeValue(el, text);
        dispatchInputChange(el, text);
        return {typed: true, mode: type};
      }
      if (type === "file") {
        throw new Error("File inputs are not supported by browser_use_type");
      }
    }
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      if (clear) {
        selectElementContents(el);
        document.execCommand("delete", false);
      }
      document.execCommand("insertText", false, text);
      dispatchInputChange(el, text);
      await sleep(150);
      return {typed: true, mode: "contenteditable"};
    }
    if (tag === "input" || tag === "textarea") {
      const value = clear ? text : `${el.value || ""}${text}`;
      setNativeValue(el, value);
      dispatchInputChange(el, text);
      await sleep(150);
      return {typed: true, mode: tag};
    }

    document.execCommand("insertText", false, text);
    await sleep(150);
    return {typed: true, mode: "activeElement"};
  }

  function focusElement(el) {
    if (typeof el.focus === "function") {
      el.focus({preventScroll: true});
    }
    el.dispatchEvent(new FocusEvent("focus", {bubbles: false}));
    el.dispatchEvent(new FocusEvent("focusin", {bubbles: true}));
  }

  function selectOption(el, text) {
    const expected = text.trim().toLowerCase();
    const options = Array.from(el.options);
    const option = options.find((item) => item.value === text || (item.text || "").trim() === text) ||
      options.find((item) => item.value.toLowerCase() === expected || (item.text || "").trim().toLowerCase() === expected);
    if (!option) {
      throw new Error(`select option not found: ${text}. Options: ${options.map((item) => item.text || item.value).join(", ")}`);
    }
    el.value = option.value;
    option.selected = true;
    dispatchInputChange(el, option.value);
  }

  function setChecked(el, text, clear) {
    const normalized = String(text).trim().toLowerCase();
    const checked = ["true", "1", "yes", "on", "checked", "select"].includes(normalized) ||
      (normalized === "" && clear === false);
    el.checked = checked;
    dispatchInputChange(el, checked ? "true" : "false");
  }

  function setNativeValue(el, value) {
    const tag = tagName(el);
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatchInputChange(el, data) {
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {bubbles: true, cancelable: true, inputType: "insertText", data}));
      el.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data}));
    } catch (error) {
      el.dispatchEvent(new Event("input", {bubbles: true}));
    }
    el.dispatchEvent(new Event("change", {bubbles: true}));
  }

  function showRecorderEditor() {
    const existing = document.getElementById("openagent-recorder-editor");
    if (existing) {
      existing.style.display = "block";
      return {shown: true, reused: true};
    }

    const shell = document.createElement("div");
    shell.id = "openagent-recorder-editor";
    shell.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:24px",
      "width:min(960px,calc(100vw - 48px))",
      "height:min(720px,calc(100vh - 48px))",
      "z-index:2147483647",
      "border:1px solid rgba(24,35,28,.22)",
      "border-radius:18px",
      "overflow:hidden",
      "background:#fff",
      "box-shadow:0 24px 80px rgba(0,0,0,.28)",
      "resize:both",
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = [
      "height:42px",
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:12px",
      "padding:0 12px 0 14px",
      "color:#fff",
      "background:#244734",
      "font:700 13px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "cursor:move",
      "user-select:none",
    ].join(";");
    header.textContent = "OpenAgent Action Recorder";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.style.cssText = [
      "height:28px",
      "padding:0 10px",
      "border:1px solid rgba(255,255,255,.45)",
      "border-radius:8px",
      "color:#fff",
      "background:rgba(255,255,255,.14)",
      "font:700 12px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "cursor:pointer",
    ].join(";");
    close.addEventListener("click", () => {
      shell.style.display = "none";
    });
    header.appendChild(close);

    const frame = document.createElement("iframe");
    frame.title = "OpenAgent Action Sequence Editor";
    frame.src = chrome.runtime.getURL("recorder.html?embed=1");
    frame.style.cssText = [
      "display:block",
      "width:100%",
      "height:calc(100% - 42px)",
      "border:0",
      "background:#f5f6f1",
    ].join(";");

    shell.append(header, frame);
    document.documentElement.appendChild(shell);
    makeRecorderEditorDraggable(shell, header);
    return {shown: true, reused: false};
  }

  function setRecorderEditorVisible(visible) {
    const shell = document.getElementById("openagent-recorder-editor");
    if (!shell) {
      return {shown: false};
    }
    shell.style.display = visible === false ? "none" : "block";
    return {shown: shell.style.display !== "none"};
  }

  function dismissPageInterference() {
    const actions = [];
    const vignette = dismissGoogleVignette();
    if (vignette) {
      actions.push(vignette);
    }
    const consent = dismissConsentDialogs();
    if (consent.length > 0) {
      actions.push(...consent);
    }
    return {dismissed: actions.length > 0, actions};
  }

  function dismissGoogleVignette() {
    if (window.location.hash !== "#google_vignette") {
      return "";
    }
    try {
      history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);
      return "google_vignette_hash";
    } catch (error) {
      window.location.hash = "";
      return "google_vignette_hash";
    }
  }

  function dismissConsentDialogs() {
    const actions = [];
    const button = findConsentButton();
    if (button) {
      button.click();
      actions.push("consent_button");
    }
    removeConsentOverlays(actions);
    return actions;
  }

  function findConsentButton() {
    const selectors = [
      "button.fc-vendor-preferences-accept-all",
      "button.fc-cta-consent",
      "button.fc-cta-do-not-consent",
      "button.fc-help-dialog-close-button",
      "[aria-label='全部接受']",
      "[aria-label='接受全部']",
      "[aria-label='同意']",
      "[aria-label='关闭']",
      "[aria-label='Accept all']",
      "[aria-label='I agree']",
      "[aria-label='Close']",
    ];
    for (const selector of selectors) {
      const found = findComposed(selector);
      if (found && isVisible(found)) {
        return found;
      }
    }
    return allElements(document).find((el) => {
      if (!["button", "a"].includes(tagName(el)) || !isVisible(el)) {
        return false;
      }
      return /^(全部接受|接受全部|同意|关闭|accept all|i agree|agree|close)$/i.test(accessibleText(el).trim());
    }) || null;
  }

  function removeConsentOverlays(actions) {
    const selectors = [
      ".fc-consent-root",
      ".fc-dialog-overlay",
      ".fc-dialog-container",
      "[id^='sp_message_container']",
      "[class*='cookie'][class*='banner']",
      "[class*='consent'][class*='banner']",
    ];
    for (const selector of selectors) {
      const nodes = [];
      try {
        nodes.push(...document.querySelectorAll(selector));
      } catch (error) {}
      for (const node of nodes) {
        if (node && node.id !== "openagent-recorder-editor") {
          node.remove();
          actions.push(`removed:${selector}`);
        }
      }
    }
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }

  function makeRecorderEditorDraggable(shell, handle) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target && tagName(event.target) === "button") {
        return;
      }
      const rect = shell.getBoundingClientRect();
      shell.style.left = `${rect.left}px`;
      shell.style.top = `${rect.top}px`;
      shell.style.right = "auto";
      shell.style.bottom = "auto";
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      const rect = shell.getBoundingClientRect();
      const nextLeft = clamp(drag.left + event.clientX - drag.startX, 0, Math.max(0, window.innerWidth - rect.width));
      const nextTop = clamp(drag.top + event.clientY - drag.startY, 0, Math.max(0, window.innerHeight - 42));
      shell.style.left = `${Math.round(nextLeft)}px`;
      shell.style.top = `${Math.round(nextTop)}px`;
    });
    handle.addEventListener("pointerup", (event) => {
      if (drag && event.pointerId === drag.pointerId) {
        drag = null;
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch (error) {}
      }
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function selectElementContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function pressKey(payload) {
    const normalized = normalizeKey(String(payload.key || ""));
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    const options = {
      key: normalized.key,
      code: normalized.code,
      keyCode: normalized.keyCode,
      which: normalized.keyCode,
      bubbles: true,
      cancelable: true,
      ctrlKey: Boolean(payload.ctrlKey),
      shiftKey: Boolean(payload.shiftKey),
      altKey: Boolean(payload.altKey),
      metaKey: Boolean(payload.metaKey),
    };
    target.dispatchEvent(new KeyboardEvent("keydown", options));
    if (normalized.key.length === 1 || normalized.key === "Enter") {
      target.dispatchEvent(new KeyboardEvent("keypress", options));
    }
    handleSyntheticKeyDefault(target, normalized, payload);
    target.dispatchEvent(new KeyboardEvent("keyup", options));
    await sleep(150);
    return {pressed: true, key: normalized.key};
  }

  function handleSyntheticKeyDefault(target, normalized, payload) {
    if (normalized.key === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
      target.form.requestSubmit();
      return;
    }
    if (normalized.key === "Tab") {
      focusNext(target, Boolean(payload.shiftKey));
      return;
    }
    if (normalized.key === "Escape" && typeof target.blur === "function") {
      target.blur();
      return;
    }
    if ((normalized.key === "Backspace" || normalized.key === "Delete") && (tagName(target) === "input" || tagName(target) === "textarea")) {
      const start = target.selectionStart || 0;
      const end = target.selectionEnd || start;
      const value = target.value || "";
      if (start !== end) {
        setNativeValue(target, value.slice(0, start) + value.slice(end));
        target.setSelectionRange(start, start);
      } else if (normalized.key === "Backspace" && start > 0) {
        setNativeValue(target, value.slice(0, start - 1) + value.slice(start));
        target.setSelectionRange(start - 1, start - 1);
      } else if (normalized.key === "Delete" && start < value.length) {
        setNativeValue(target, value.slice(0, start) + value.slice(start + 1));
        target.setSelectionRange(start, start);
      }
      dispatchInputChange(target, "");
    }
  }

  function normalizeKey(key) {
    const map = {
      "\r": ["Enter", "Enter", 13],
      "\n": ["Enter", "Enter", 13],
      "\t": ["Tab", "Tab", 9],
      "\b": ["Backspace", "Backspace", 8],
      " ": [" ", "Space", 32],
      Enter: ["Enter", "Enter", 13],
      Tab: ["Tab", "Tab", 9],
      Escape: ["Escape", "Escape", 27],
      Esc: ["Escape", "Escape", 27],
      Backspace: ["Backspace", "Backspace", 8],
      Delete: ["Delete", "Delete", 46],
      Home: ["Home", "Home", 36],
      End: ["End", "End", 35],
      PageUp: ["PageUp", "PageUp", 33],
      PageDown: ["PageDown", "PageDown", 34],
      ArrowUp: ["ArrowUp", "ArrowUp", 38],
      ArrowDown: ["ArrowDown", "ArrowDown", 40],
      ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
      ArrowRight: ["ArrowRight", "ArrowRight", 39],
    };
    const item = map[key] || [key, key, key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0];
    return {key: item[0], code: item[1], keyCode: item[2]};
  }

  function focusNext(current, reverse) {
    const focusables = allElements(document)
      .filter((el) => {
        const tag = tagName(el);
        return ["a", "button", "input", "textarea", "select"].includes(tag) || el.tabIndex >= 0 || el.isContentEditable;
      })
      .filter(isVisible)
      .filter((el) => !isDisabled(el));
    const index = focusables.indexOf(current);
    const next = reverse ? focusables[index - 1] || focusables[focusables.length - 1] : focusables[index + 1] || focusables[0];
    if (next && typeof next.focus === "function") {
      next.focus();
    }
  }

  function playMedia() {
    const media = allElements(document).filter((item) => ["video", "audio"].includes(tagName(item)));
    if (media.length === 0) {
      return {text: "No audio or video elements found on the current tab."};
    }
    const visibleMedia = media.filter(isVisible);
    const candidates = visibleMedia.length ? visibleMedia : media;
    const reports = [];
    for (const item of candidates) {
      item.muted = false;
      item.volume = 1;
      try {
        const promise = item.play();
        if (promise && typeof promise.catch === "function") {
          promise.catch(() => {});
        }
        reports.push(`${tagName(item)}: playing=${!item.paused} muted=${item.muted} volume=${item.volume} currentTime=${Math.round(item.currentTime || 0)}`);
      } catch (error) {
        reports.push(`${tagName(item)}: play failed: ${error.message || String(error)}`);
      }
    }
    return {text: reports.join("\n")};
  }

  function mediaState() {
    const media = allElements(document).filter((item) => ["video", "audio"].includes(tagName(item)));
    if (media.length === 0) {
      return "none";
    }
    return media.slice(0, 8).map((item, index) => {
      const tag = tagName(item);
      const state = item.paused ? "paused" : "playing";
      const currentTime = Number.isFinite(item.currentTime) ? Math.round(item.currentTime) : 0;
      const duration = Number.isFinite(item.duration) ? Math.round(item.duration) : 0;
      return `${tag}[${index + 1}]: ${state}, muted=${item.muted}, volume=${item.volume}, time=${currentTime}s/${duration}s`;
    }).join("\n");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function installRecorderListeners() {
    document.addEventListener("pointerdown", (event) => {
      if (!recorder.active || event.button !== 0) {
        return;
      }
      const el = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      if (!el) {
        return;
      }
      recorder.lastPointerDown = {
        el,
        x: event.clientX,
        y: event.clientY,
        time: Date.now(),
      };
      recorder.dragStart = recorder.lastPointerDown;
    }, true);

    document.addEventListener("click", (event) => {
      if (!recorder.active || event.detail > 1) {
        return;
      }
      const el = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      if (!el) {
        return;
      }
      sendRecordedStep({
        kind: "click",
        ...elementRecorderInfo(el, event),
      });
    }, true);

    document.addEventListener("dblclick", (event) => {
      if (!recorder.active) {
        return;
      }
      const el = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      if (!el) {
        return;
      }
      sendRecordedStep({
        kind: "dblclick",
        ...elementRecorderInfo(el, event),
      });
    }, true);

    document.addEventListener("input", (event) => {
      if (!recorder.active) {
        return;
      }
      const el = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : null;
      if (!el || !["input", "textarea", "select"].includes(tagName(el))) {
        return;
      }
      recorder.lastInputAt = Date.now();
      const value = tagName(el) === "select" ? valueText(el) : el.value || "";
      sendRecordedStep({
        kind: "type",
        text: `{{${variableNameFor(el)}}}`,
        value,
        clear: true,
        ...elementRecorderInfo(el, event),
      });
    }, true);

    document.addEventListener("keydown", (event) => {
      if (!recorder.active) {
        return;
      }
      if (!["Enter", "Tab", "Escape", "Backspace", "Delete"].includes(event.key)) {
        return;
      }
      if (Date.now() - recorder.lastInputAt < 80 && event.key !== "Enter") {
        return;
      }
      sendRecordedStep({
        kind: "press",
        key: event.key,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
    }, true);

    document.addEventListener("drop", (event) => {
      if (!recorder.active || !recorder.dragStart) {
        return;
      }
      const source = recorder.dragStart.el;
      const target = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target.parentElement;
      if (!source || !target || source === target) {
        return;
      }
      sendRecordedStep({
        kind: "drag_and_drop",
        source: elementRecorderInfo(source, {clientX: recorder.dragStart.x, clientY: recorder.dragStart.y}),
        target: elementRecorderInfo(target, event),
      });
      recorder.dragStart = null;
    }, true);
  }

  installRecorderListeners();
})();
