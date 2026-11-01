<h1><img src="docs/images/mark.svg" width="28" alt=""> Ridealong</h1>

**A real browser for any AI agent. Plug it into anything that speaks MCP, ride along, and take the wheel when you need to.**

Ridealong runs a real, logged-in Brave browser on your server. Claude Code, Codex, Gemini CLI, Cursor or any other MCP client can drive it. You follow along live from a web viewer, and when an agent hits a 2FA code or a CAPTCHA, it asks you to step in and carries on when you hand back.

![Ridealong showing an agent working in a browser](docs/images/working.png)

## Why

Agents get stuck wherever there's no API: dashboards, admin panels, anything behind a login. Headless browsers can't get past 2FA, and you can't see what they're doing. Ridealong gives agents a real browser that stays signed in, and gives you a live view with a clean way to step in.

- **Real browser:** Brave with its own profile, so logins persist. It runs permanently on a virtual display and survives crashes and reboots.
- **Live viewer:** see the agent's cursor and what it's doing, from any device.
- **Human handover:** the agent asks, you step in, you hand back. It waits for you and resumes on its own.
- **Safe by default:** the viewer is locked while agents work, and agents pause when you take control.
- **Plug and play:** one command connects any MCP client. There are no providers or plugins to add, and any model works.
- **Parallel agents:** every session gets its own tab, so they can work at the same time.

## Install

Tested on Ubuntu 24.04 (x86-64). Debian and arm64 should work but haven't been tested.

```
git clone https://github.com/Christian-Gennari/ridealong
cd ridealong
sudo ./install.sh
```

It takes about 3 minutes and prints your viewer link. Then open the viewer, choose **Control**, sign into your accounts in Brave, and go back to **Auto**.

To upgrade, `git pull` and run it again. To remove it, run `sudo ./install.sh --uninstall`; your Brave profile stays in `~/.ridealong-browser`.

## Using it

| Mode | What happens |
|---|---|
| **Auto** | Locked while agents work, so a stray click can't disturb them. Unlocks when one asks for you, and locks again when you hand back. |
| **Watch** | Always locked. |
| **Control** | The browser is yours, and agents wait until you release it. |

Want to step in while an agent is working? Press **Control**, or click the screen and choose **Take control**. The agent finishes its current action and waits until you release it.

When an agent needs you, the viewer says **Your turn** with the reason. Do what it asks and press **Hand back**.

![The viewer asking the user to enter a 2FA code](docs/images/your-turn.png)

Activity and settings live in the sidebar, in light or dark.

![Ridealong in dark mode with the settings panel open](docs/images/dark.png)

## Parallel agents

Every agent session gets its own tab and its own label (Claude, Claude 2, and so on), so sessions can work at the same time without touching each other's pages. They share one browser, so they also share logins. The tabs are grouped by session and close when the session ends.

The screen stays on one session rather than flipping between them. Pick which one to watch in the top bar. If several need you, their requests queue, and the screen goes to each in turn.

Isolation is per MCP connection. Subagents that share one connection also share one tab, so give browser work to one subagent at a time.

## Reaching the viewer

The viewer controls a logged-in browser, so it stays on `127.0.0.1` unless you choose otherwise. The installer picks the option automatically; override it with `--network`.

| Option | How | Best for |
|---|---|---|
| **Tailscale** (recommended) | Detected automatically. Gives a private `https://` link. | Any device, including your phone, with no open ports. |
| **SSH tunnel** | The default without Tailscale: `ssh -L 6086:127.0.0.1:6086 you@server`, then open `http://127.0.0.1:6086`. | Occasional use, nothing to install. |
| **Your own proxy** | Point Cloudflare Tunnel or a reverse proxy at `127.0.0.1:6086`, with your own login in front. | If you already run one. |
| **LAN** | `--network lan` gives a secret link over plain HTTP. | Trusted home networks only. |

Never expose the viewer to the internet without a login in front of it.

## Connect any MCP client

Ridealong is a standard MCP server, so it's plug and play: if a tool can run a local MCP server, it works, whichever model is behind it. Everything points at one command, `ridealong-mcp`.

The installer connects Claude Code, Codex, Gemini CLI and Hermes if it finds them. For anything else:

```bash
claude mcp add ridealong -- ridealong-mcp --agent Claude      # Claude Code
codex mcp add ridealong -- ridealong-mcp --agent Codex        # Codex
gemini mcp add ridealong ridealong-mcp -- --agent Gemini      # Gemini CLI
```

Tools configured with JSON, like Cursor and Claude Desktop, use this:

```json
{
  "mcpServers": {
    "ridealong": { "command": "ridealong-mcp", "args": ["--agent", "Cursor"] }
  }
}
```

`--agent` is the name you'll see in the viewer. Clients receive the usage rules when they connect, so no extra setup is needed.

The ChatGPT web and desktop apps can't use it: they only connect to remote MCP servers, and this one shouldn't be exposed to the internet. Use Codex instead.

## How it works

| Service | What it does |
|---|---|
| `ridealong-display` | Xvfb virtual display |
| `ridealong-desktop` | Lightweight XFCE session |
| `ridealong-brave` | Brave, with remote debugging on `127.0.0.1:9222` |
| `ridealong-vnc` | x11vnc on `127.0.0.1:5900` |
| `ridealong-viewer` | The web UI, the VNC relay and who-has-control |

`ridealong-mcp` is a small wrapper in front of `@playwright/mcp`. It tells the viewer and a browser extension what's happening, adds a short pause before each click so you can follow it, holds tools while you have control, and adds the `browser_handover` tool. If the viewer is down, agents keep working. Set `RIDEALONG_PLAIN=1` to bypass the wrapper entirely.

Check on it with `ridealong-status`, and read logs with `journalctl -u ridealong-brave -f`.

## Security

Treat Ridealong as giving your agents your logged-in browser, and sign in only where you'd accept that.

- **Saved passwords are stored unencrypted** in `~/.ridealong-browser`, because there's nobody at boot to unlock a keyring. Any process running as your user can read them and can drive the browser. Keep payment and other high-value accounts out of this profile.
- **The viewer has no login of its own,** except the secret link in LAN mode. The lock protects against accidents, not people.
- **Other websites can't reach it:** the viewer refuses connections from other origins.
- Agents read untrusted pages, so prompt injection is a real risk. The installed instructions tell them to treat page text as data, which reduces the risk but doesn't remove it.

## License

MIT. noVNC (MPL-2.0) and Inter (OFL) are included under their own licenses.
