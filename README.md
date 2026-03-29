# Twitter Bridge MCP

Connect Claude.ai to Twitter/X — without paying $100/month for the official API.

Uses [bb-browser](https://github.com/epiral/bb-browser/releases/tag/bb-browser-v0.10.0) (open-source browser automation) to control a logged-in Chrome session, wrapped as an MCP server that Claude.ai can talk to.

```
Claude.ai ──MCP──▶ your-server:8080 ──bb-browser──▶ Chrome (logged in) ──▶ Twitter/X
```

**Cost: ~$5/year** (just a domain for Cloudflare Tunnel).

## What it can do

| Tool | Method | Status |
|------|--------|--------|
| `twitter_post` | Browser automation | ✅ |
| `twitter_reply` | Browser automation | ✅ |
| `twitter_like` | GraphQL API | ✅ |
| `twitter_retweet` | GraphQL API | ✅ |
| `twitter_quote` | Browser automation | ✅ |
| `twitter_follow` | Browser automation | ✅ |
| `twitter_unfollow` | Browser automation | ✅ |
| `twitter_undo` | GraphQL API | ✅ |
| `twitter_search` | Browser DOM parsing | ✅ |
| `twitter_timeline` | Browser DOM parsing | ✅ |
| `twitter_bookmarks` | Browser DOM parsing | ✅ |
| `twitter_tweets` | Browser DOM parsing | ✅ |
| `twitter_notifications` | bb-sites adapter | ✅ |
| `twitter_user` | bb-sites adapter | ✅ |
| `twitter_view_tweet` | Browser DOM parsing | ✅ |
| `twitter_mentions` | Browser DOM parsing | ✅ |
| `twitter_my_replies` | Browser DOM parsing | ✅ |
| `twitter_dm_read` | Browser automation | ⚠️ partial |
| `twitter_screenshot` | bb-browser | ✅ |
| `browser_open` | bb-browser | ✅ |
| `browser_snapshot` | bb-browser | ✅ |

> DM reading works but Twitter's E2E encryption may limit what's visible via browser automation.


## What's new in v0.6.1

- **`twitter_view_tweet` now includes replies** — Pass `include_replies: true` (default) to fetch up to 20 replies from the tweet's thread. Uses `cellInnerDiv` container traversal with auto-scrolling.
- **New: `twitter_mentions`** — Fetches tweets that mention/reply to you from the Mentions tab.
- **New: `twitter_my_replies`** — Fetches your own replies to other tweets. Requires `screen_name` parameter.
- **Token persistence** — OAuth tokens are now saved to `.tokens.json` and survive server restarts. No more re-authenticating after every reboot.
- **Tab switching fix** — Fixed a bug where `bb-browser open` creates a new tab without switching to it, causing all subsequent operations to run on the wrong page. Affects `view_tweet`, `openAndParseTweets` (used by timeline, search, bookmarks, tweets, mentions, my_replies).
- **Smart page loading** — `view_tweet` now polls for the main tweet article to appear (up to 15s) instead of using a fixed sleep, improving reliability on slow connections.

## Architecture

The server has three layers:

1. **MCP + OAuth** — Claude.ai connects via Streamable HTTP transport with auto-approved OAuth 2.0 (PKCE).
2. **Tool implementations** — 19 tools split between browser automation (open page → wait → parse DOM) and GraphQL API calls (for lightweight actions like like/retweet/undo).
3. **bb-browser** — Controls Chrome via CDP (Chrome DevTools Protocol), inheriting the logged-in session.

Browser automation was chosen over GraphQL API for most read operations because Twitter's API requires a `x-client-transaction-id` header generated from webpack internals — the module IDs change on every Twitter deploy, causing random 404s. DOM parsing is slower but never breaks.

## Prerequisites

- **Node.js** ≥ 18
- **Chrome** (or Chromium) with remote debugging enabled
- **bb-browser** — Install from [GitHub](https://github.com/epiral/bb-browser/releases/tag/bb-browser-v0.10.0)
- **A Twitter/X account** — logged in within the Chrome profile
- **Cloudflare Tunnel** (or any reverse proxy) — to expose your local server with HTTPS

## Setup

### 1. Start Chrome with CDP

```bash
# Create a dedicated Chrome profile
mkdir -p ~/chrome-mcp-profile

# Launch Chrome with remote debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/chrome-mcp-profile
```

Log in to Twitter/X in this Chrome window.

### 2. Install & configure

```bash
git clone https://github.com/replica882/twitter-bridge-mcp.git
cd twitter-bridge-mcp
npm install

cp .env.example .env
# Edit .env with your values
```

### 3. Run

```bash
node server.mjs
# Twitter MCP Bridge v0.6.1: http://0.0.0.0:8080/mcp
```

### 4. Expose via Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:8080
```

Or set up a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for a permanent URL.

### 5. Connect from Claude.ai

In Claude.ai → Settings → Connected Tools → Add Custom Connector:
- URL: `https://your-tunnel-domain.com/mcp`

Claude will auto-discover OAuth endpoints and connect.

## Configuration

All config is via environment variables (or `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `BASE_URL` | `http://localhost:8080` | Public URL (for OAuth discovery) |
| `BB_BROWSER_PATH` | `~/local/bin/bb-browser` | Path to bb-browser binary |
| `DM_PIN` | *(empty)* | Twitter DM encryption PIN (if set up) |
| `OAUTH_CLIENT_ID` | `twitter-mcp-client` | OAuth client ID |
| `OAUTH_CLIENT_SECRET` | *(auto-generated)* | OAuth client secret |

## How it works

### Why not the official API?

Twitter/X API Basic tier costs $100/month. This project does the same thing for $5/year by automating a real browser session.

### Why not just GraphQL?

Twitter's internal GraphQL API requires a `x-client-transaction-id` header. This ID is generated by a function buried in Twitter's webpack bundles — the module number changes every time Twitter deploys. We use GraphQL only for simple mutations (like, retweet, delete) that don't need this header. Everything else uses DOM parsing.

### Tab management

Every browser operation opens a new tab. Without cleanup, Chrome accumulates 40+ tabs and crashes. The server auto-closes excess tabs, keeping a maximum of 10.

### DM PIN auto-entry

Twitter requires a PIN every time you open the DM page (E2E encryption). If `DM_PIN` is set, the server auto-enters it using React-compatible input simulation (native property setter + keyboard events).

## Gotchas

- **Chrome profile encryption** — Cookie storage is bound to a profile key. You can't copy a Chrome profile directory to migrate login state. Always use `--user-data-dir` and log in manually.
- **React contenteditable** — Twitter's compose box is a `contenteditable` div. Normal DOM manipulation doesn't trigger React state updates. The server uses `ClipboardEvent paste` for quote tweets and bb-browser's `type` command for regular posts.
- **Search occasionally empty** — If you search too quickly after page load, DOM might not be populated yet. The server waits 4 seconds, which works reliably.
- **launchd/systemd and dotenv** — If you run the server as a system service, make sure to set `WorkingDirectory` to the project directory. Without this, dotenv can't find `.env`, `BASE_URL` falls back to `http://localhost:8080`, and OAuth discovery returns localhost URLs — Claude.ai will fail to connect. For macOS launchd, add `<key>WorkingDirectory</key><string>/path/to/twitter-bridge-mcp</string>` to your plist. For systemd, add `WorkingDirectory=/path/to/twitter-bridge-mcp` to your unit file.
- **Server restart loses OAuth tokens** — OAuth tokens are stored in memory. Every server restart requires reconnecting from Claude.ai (Settings → Connected Tools → reconnect Twitter Bridge).

## Credits

- [bb-browser](https://github.com/epiral/bb-browser/releases/tag/bb-browser-v0.10.0) — the browser automation engine that makes this possible
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) — Model Context Protocol server framework
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — free HTTPS tunneling

## License

MIT
