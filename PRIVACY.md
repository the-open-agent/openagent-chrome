# Privacy Policy — OpenAgent Browser Bridge

*Last updated: 2026-05-03*

## What data the extension stores

The extension stores only two items locally in your browser via `chrome.storage.local`:

| Item       | Purpose                                                  |
|------------|----------------------------------------------------------|
| Server URL | The address of your local OpenAgent backend              |
| Auth token | An optional token used to authenticate with that backend |

Both values remain on your device and are never transmitted to any third-party server.

## What data leaves your device

All communication is between your browser and the **local server you configure** (default: `http://127.0.0.1:14000`). Specifically:

- A WebSocket connection is opened to that local address
- DOM snapshots, tab metadata, and interaction results are sent through that connection
- No data is sent to the extension developer or any external service

## Permissions and their use

The extension requests broad host permissions (`<all_urls>`) solely to inject its content script into whichever tab the AI agent is instructed to operate. It does not read, collect, or transmit browsing history.

## No analytics or telemetry

The extension contains no analytics, crash reporting, or telemetry code of any kind.

## Contact

For questions or concerns, open an issue at <https://github.com/the-open-agent/openagent-chrome/issues>.
