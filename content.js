(() => {
  if (window.__casibaseBrowserBridgeContentLoaded) {
    return;
  }
  window.__casibaseBrowserBridgeContentLoaded = true;

  const maxElements = 140;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "casibase-command") {
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
    case "type":
      return typeIntoElement(payload);
    case "press":
      return pressKey(payload);
    case "playMedia":
      return playMedia();
    case "mediaState":
      return {text: mediaState()};
    default:
      throw new Error(`Unsupported content command: ${command}`);
    }
  }

  function snapshot(payload) {
    allElements(document).forEach((el) => {
      if (el.hasAttribute("data-casibase-browser-ref")) {
        el.removeAttribute("data-casibase-browser-ref");
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
    el.setAttribute("data-casibase-browser-ref", ref);
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
      const byRef = findComposed(`[data-casibase-browser-ref="${escaped}"]`);
      if (byRef) {
        return byRef;
      }
      throw new Error(`Element index/ref ${index} was not found. Call browser_use_snapshot again before reusing indexes`);
    }
    throw new Error("Missing index, ref, or selector");
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

  async function clickElement(payload) {
    const el = resolveTarget(payload);
    el.scrollIntoView({block: "center", inline: "center"});
    await sleep(80);
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
    el.scrollIntoView({block: "center", inline: "center"});
    await sleep(80);
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
})();
