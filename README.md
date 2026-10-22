# Tunnel Vision — FortiGate VPN keys for Stream Deck

One Stream Deck key per FortiGate VPN profile. Press to connect, press again to disconnect; the key shows the live state. Works on **macOS** (openfortivpn) and **Windows** (openconnect).

There's also a **macOS VPN** key that toggles any VPN from macOS *System Settings → VPN* (see below).

## Install

Download the latest file from [`releases/`](releases/) (e.g. `TunnelVision-1.3.0.streamDeckPlugin`) and double-click it. It's one package for both macOS and Windows — the plugin is JavaScript run by Stream Deck's bundled Node.js, and the Windows helper scripts ship inside it. Then open a key's settings and follow its **Setup** checklist.

| Key | Meaning |
|---|---|
| Grey shield, power glyph, **OFF** | Disconnected |
| Amber pulsing shield, **CONNECTING / STOPPING** | Working on it (press while connecting to cancel) |
| Green shield, ✓, **ON 1h05** | Tunnel up, with uptime |
| Red shield, **!**, **ERROR** | Last attempt failed — open the key's settings to see why |
| Blue **SETUP** | Gateway / username not filled in yet |

**Setup is built in:** the top of each key's settings panel has a **Setup** checklist that checks what this computer still needs, ticks off what's done, and has a button for each fix (download link, *Run setup*, *Add sudo rule*, copyable commands). A key shows **SETUP** until everything is green. The manual steps below are the same thing, for reference.

Each key's settings panel has gateway, port, username, password, trusted cert, a Connect/Disconnect button, the last error, and the connection log. If the gateway's certificate isn't trusted yet, the panel shows the fingerprint the VPN client reported with a **Trust this certificate** button.

---

## macOS

- Each key runs `~/.local/bin/openfortivpn-connect.sh <host> <port> <user> <password> [trusted-cert]` (path configurable under *Advanced*).
- Output goes to `~/Library/Logs/TunnelVision/<profile>.log` (and `/var/log/vpn.log` via the script's `tee`).
- Status: the log (`Tunnel is up and running`) plus `pgrep -f "openfortivpn <host>:<port>"` every 4 s.
- Disconnect: `sudo -n pkill -TERM -f "openfortivpn <host>:<port>"` (just that profile), or the script's `kill` (all tunnels) under *Advanced*.
- Passwords: macOS login Keychain, service `com.avremy.openfortigate`, one item per key.

### One-time setup: passwordless sudo

Easiest: **Setup → Add sudo rule** in the key's settings (macOS asks for your password once; the rule is checked with `visudo` before it's installed). Or by hand:

```sh
sudo visudo -f /etc/sudoers.d/openfortivpn
```

and paste (see `sudoers.example`):

```
avremy ALL=(root) NOPASSWD: /opt/homebrew/bin/openfortivpn, /usr/bin/killall openfortivpn, /usr/bin/pkill -TERM -f openfortivpn *
```

Without it, keys go red with *"sudo wants a password"*.

---

## Windows

openfortivpn has no official Windows build, so on Windows the plugin drives **openconnect** (9.0+) with `--protocol=fortinet`. Same keys, same settings panel.

### 1. Install openconnect

Install **OpenConnect-GUI** from <https://gui.openconnect-vpn.net/download/> and on the components page **tick the command-line / console version** — that's what installs `openconnect.exe` (plus the Wintun driver and `vpnc-script-win.js`). Keep the default folder, `C:\Program Files\OpenConnect-GUI\`.

(Any openconnect 9+ build works; pass its path to setup with `-OpenConnectPath`.)

### 2. Install the plugin

Double-click `TunnelVision.streamDeckPlugin` (from `npm run pack`, in `dist/`).

### 3. Run the one-time setup as administrator

Easiest: open any Tunnel Vision key's settings → **Setup → Run setup** and approve the Windows admin prompt. After plugin updates the checklist tells you if the helper is out of date — click *Run setup* again. Or by hand:

Connecting needs admin rights (it creates a network adapter), and Stream Deck can't answer UAC prompts. The setup script installs a small helper and two scheduled tasks that run it elevated — the Windows equivalent of the sudoers rule. Open **PowerShell as Administrator** and run:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\Elgato\StreamDeck\Plugins\com.avremy.openfortigate.sdPlugin\windows\Setup-TunnelVision.ps1"
```

It finds `openconnect.exe`, copies the helper to `C:\Program Files\TunnelVision\`, and registers **TunnelVision Connect** and **TunnelVision Stop** (run as you, highest privileges, only while you're logged on). Options:

| Option | Use |
|---|---|
| `-OpenConnectPath <path>` | openconnect.exe somewhere else |
| `-User DOMAIN\name` | the Stream Deck user, if you're running setup from a different admin account (that user must be an administrator) |
| `-NoHeadless` | if your Windows build doesn't support `conhost --headless` (you'll see a brief console flash) |
| `-Uninstall` | remove the tasks and helper |

### How it works on Windows

- Per-profile data lives in `%LOCALAPPDATA%\TunnelVision\`:
  - `profiles\<id>.json` — gateway, port, username, cert (no secrets)
  - `profiles\<id>.pw` — the password, DPAPI-encrypted so only your Windows account can decrypt it
  - `logs\<id>.log`, `run\<id>.pid`
- A key press writes a small request file and starts the matching scheduled task. The helper validates the profile, decrypts the password, runs `openconnect --protocol=fortinet --non-inter --passwd-on-stdin --user <user> [--servercert <fp>] https://<host>:<port>/` and pipes the password in on stdin (never on a command line).
- Connected = openconnect logs `Configured as <ip>…`. Status is also checked every 4 s from the PID file, so tunnels survive a Stream Deck restart.
- Trusted cert accepts openconnect's `pin-sha256:…` (what the **Trust** button fills in) or a 64-char SHA256 hex fingerprint (the same one openfortivpn uses on the Mac).
- Disconnect stops that profile's openconnect process; *All tunnels* stops every tunnel the helper started.

### Troubleshooting (Windows)

- **"Windows helper isn't set up"** — run step 3, or re-run it after moving openconnect.
- **Stuck on CONNECTING then ERROR** — open the key's connection log. Certificate failures show the `pin-sha256` fingerprint → click **Trust this certificate**.
- **Connected but can't reach anything** — check `vpnc-script-win.js` sits next to `openconnect.exe` (OpenConnect-GUI installs it).
- Killing openconnect doesn't run the vpnc script's cleanup; Windows drops the routes with the adapter, but a stale address can occasionally linger on the Wintun adapter until the next connect.

---

## macOS VPN key

The **macOS VPN** action (Mac only — hidden on Windows) toggles a VPN that's configured in *System Settings → VPN*: IKEv2, IPSec, L2TP, and VPN apps that register a system VPN there (FortiClient, Tailscale, WireGuard, …).

- Pick the VPN from the dropdown in the key's settings; the key shows **ENABLED** (green) or **DISABLED** (grey), **CONNECTING / STOPPING** while it changes, and **FAILED** (red) if a start didn't come up.
- It uses `scutil --nc list | start | stop` — no sudo or setup needed. Status is refreshed every 2.5 s, so changes made from the menu bar or System Settings show up on the key too.
- A VPN that needs a password macOS hasn't saved can't be started from the key: save it in System Settings first (or the VPN app has to be running, for app-based VPNs).

---

## Develop

```sh
npm install
npm run build      # bundles src/ → com.avremy.openfortigate.sdPlugin/bin/plugin.js
npm run link       # symlinks the .sdPlugin into Stream Deck (once, on the dev machine)
npm run restart    # reloads the plugin
npm run watch      # rebuild + restart on save
npm run pack       # dist/com.avremy.openfortigate.streamDeckPlugin for installing elsewhere (e.g. Windows)
npm run release    # build + pack + copy to releases/TunnelVision-<version>.streamDeckPlugin (committed)
```

To cut a release: bump `version` in `package.json` and `Version` in `manifest.json`, run `npm run release`, commit the new file in `releases/`.

Layout: `src/actions/vpn-toggle.ts` (FortiGate keys) and `src/actions/native-vpn.ts` (macOS VPN key, via `src/native/scutil.ts`); `src/vpn-session.ts` is the OS-independent state machine (tails the log, tracks status); `src/platform/mac.ts` and `src/platform/win.ts` do the OS-specific start/stop/detect/password work; the Windows helper scripts ship inside the plugin under `windows/`.

## Notes

- macOS: your script passes the VPN password on the command line, so it's visible in `ps` while the tunnel runs. (Windows doesn't have this issue.)
- Duplicating a key copies its profile ID, so both copies share one password and one tunnel. Drag a fresh key from the action list for a separate profile.
- Both elevation setups (sudoers wildcard on macOS, the scheduled tasks on Windows) let processes running as you start the VPN client elevated. On Windows the helper only accepts validated host/port/user/cert values and a fixed openconnect path, and setup warns if `openconnect.exe` is writable by non-admins.
