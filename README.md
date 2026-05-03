# OpenAgent Browser Bridge

A Chrome extension (Manifest V3) that connects your local Chrome profile to [OpenAgent](https://github.com/the-open-agent) Browser Use, letting AI agents operate tabs you already own — complete with your logins, cookies, and extensions.

## How it works

The extension runs a persistent WebSocket connection to your local OpenAgent backend. When Browser Use issues a command, it travels through that connection to the extension, which executes it in the target tab:

```
OpenAgent backend  ──WebSocket──►  background.js  ──chrome.tabs──►  content.js  ──DOM──►  page
```

Supported commands: `tabs`, `state`, `open`, `snapshot`, `click`, `type`, `press`, `switchTab`, `closeTab`, `playMedia`, `mediaState`.

## Installation

### From Chrome Web Store *(recommended)*

Search for **"OpenAgent Browser Bridge"** in the Chrome Web Store and click **Add to Chrome**.

### From source

1. Clone this repository:
   ```bash
   git clone https://github.com/the-open-agent/openagent-chrome.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the cloned folder

## Usage

1. Make sure your OpenAgent backend is running (default: `http://127.0.0.1:14000`)
2. Click the extension icon in the Chrome toolbar
3. Enter the **OpenAgent URL** (leave as default if running locally)
4. Optionally enter an **auth token** if your backend requires one
5. Click **Connect**

The status indicator turns green when the bridge is live. The extension automatically reconnects if the connection drops.

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabs` | List and switch between tabs |
| `activeTab` | Access the currently active tab |
| `scripting` | Inject the content script to interact with page DOM |
| `storage` | Persist server URL and connection preferences |
| `webNavigation` | Enumerate frames within a tab for iframe support |
| `alarms` | Keep the service worker alive for a persistent connection |
| `<all_urls>` | Operate on tabs opened to any URL |

Sensitive Chrome-internal pages (`chrome://`, `chrome-extension://`, `devtools://`, etc.) are always blocked from AI control.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## Contributing

Pull requests are welcome. Please open an issue first for significant changes.

## License

Apache 2.0 — see [LICENSE](LICENSE).
