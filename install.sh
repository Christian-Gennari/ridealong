#!/usr/bin/env bash
# One-command install of Ridealong, a self-hosted browser for AI agents.
# Ubuntu or Debian.
#
#   sudo ./install.sh                     install or upgrade; network chosen automatically
#   sudo ./install.sh --network ssh       tailscale | ssh | lan
#   sudo ./install.sh --allow-host NAME   also accept this address (your own proxy)
#   sudo ./install.sh --notify URL        push to this URL (e.g. ntfy) when it's your turn
#   sudo ./install.sh --test              also run the crash tests on an upgrade
#   sudo ./install.sh --uninstall         remove it (keeps the Brave profile)
#
# Safe to re-run. Log: /opt/ridealong/install.log
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP=/opt/ridealong
NODE_VERSION=v24.15.0
VIEWER_PORT=6086
HTTPS_PORT=6087
NETWORK=auto
RUN_TESTS=no
ALLOW_HOST=
NOTIFY=
SERVICES="ridealong-display ridealong-desktop ridealong-vnc ridealong-viewer ridealong-brave"
OLD_SERVICES="agent-display agent-desktop agent-vnc agent-novnc agent-viewer agent-brave"

while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK=$2; shift 2 ;;
    --port) VIEWER_PORT=$2; shift 2 ;;
    --https-port) HTTPS_PORT=$2; shift 2 ;;
    --test) RUN_TESTS=yes; shift ;;
    --allow-host) ALLOW_HOST=$2; shift 2 ;;
    --notify) NOTIFY=$2; shift 2 ;;
    --uninstall) NETWORK=uninstall; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo ./install.sh"; exit 1; }

if [ "$NETWORK" = uninstall ]; then
  for s in $SERVICES; do
    systemctl disable --now "$s" 2>/dev/null || true
    rm -f "/etc/systemd/system/$s.service"
  done
  systemctl daemon-reload
  systemctl reset-failed 'ridealong-*' 2>/dev/null || true
  [ -f "$APP/config.env" ] && . "$APP/config.env"
  [ "${NETWORK_MODE:-}" = tailscale ] && tailscale serve --https="$HTTPS_PORT" off || true
  if [ -n "${RIDEALONG_USER:-}" ]; then
    sudo -u "$RIDEALONG_USER" -H "$APP/setup-agents.sh" --remove || echo "WARNING: couldn't remove the agents' ridealong entries."
  fi
  systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target
  [ -f "$APP/default-target" ] && systemctl set-default "$(cat "$APP/default-target")"
  rm -rf "$APP" /usr/local/bin/ridealong-status /usr/local/bin/ridealong-prestart /usr/local/bin/ridealong-mcp
  echo "Removed. Your Brave profile is still in ~/.ridealong-browser."
  exit 0
fi

U=${SUDO_USER:-}
[ -n "$U" ] && [ "$U" != root ] || { echo "Run this with sudo from your normal user, not as root."; exit 1; }
H=$(getent passwd "$U" | cut -d: -f6)
command -v apt-get >/dev/null || { echo "This installer supports Ubuntu and Debian only."; exit 1; }
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
esac

# Before anything is installed, since the machine would be left half set up.
for dm in gdm3 lightdm sddm; do
  dpkg -s "$dm" >/dev/null 2>&1 && { echo "A display manager ($dm) is installed. Ridealong needs a server without one."; exit 1; }
done

FIRST_INSTALL=no
systemctl is-active -q ridealong-display 2>/dev/null || FIRST_INSTALL=yes
[ "$FIRST_INSTALL" = yes ] && RUN_TESTS=yes

mkdir -p "$APP"
exec > >(tee "$APP/install.log") 2>&1

echo "=== $(date -Is) packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils python3
curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
  https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
curl -fsSLo /etc/apt/sources.list.d/brave-browser-release.sources \
  https://brave-browser-apt-release.s3.brave.com/brave-browser.sources
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  xvfb xfce4 xfce4-terminal dbus-x11 xdotool x11vnc imagemagick \
  x11-xserver-utils adwaita-icon-theme fonts-dejavu-core brave-browser

echo "=== migrating earlier installs"
# Older versions used these names. Move the profile so logins survive.
for s in $OLD_SERVICES; do
  systemctl disable --now "$s" 2>/dev/null || true
  rm -f "/etc/systemd/system/$s.service"
done
systemctl daemon-reload
systemctl reset-failed 'agent-*' 2>/dev/null || true
rm -rf /opt/agent-browser /usr/local/bin/agent-browser-status /usr/local/bin/agent-brave-prestart
if [ -d "$H/.agent-brave" ] && [ ! -e "$H/.ridealong-browser" ]; then
  mv "$H/.agent-brave" "$H/.ridealong-browser"
fi

echo "=== Node $NODE_VERSION"
# Private to this app, so nothing depends on the system Node or on nvm.
if [ "$("$APP/node/bin/node" -v 2>/dev/null)" != "$NODE_VERSION" ]; then
  T=$(mktemp -d)
  NODE_FILE=node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz
  curl -fsSLo "$T/$NODE_FILE" "https://nodejs.org/dist/$NODE_VERSION/$NODE_FILE"
  curl -fsSLo "$T/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$T" && grep " $NODE_FILE\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$APP/node"
  mkdir -p "$APP/node"
  tar -xJf "$T/$NODE_FILE" -C "$APP/node" --strip-components=1
  rm -rf "$T"
fi

echo "=== app files"
rm -rf "$APP/ridealong-cursor" "$APP/mcp" "$APP/docs" "$APP/scripts" "$APP/viewer/public"
mkdir -p "$APP/viewer"
cp -r "$SRC/ridealong-cursor" "$SRC/mcp" "$SRC/docs" "$SRC/scripts" "$APP/"
cp -r "$SRC/viewer/public" "$SRC/viewer/server.mjs" "$SRC/viewer/package.json" "$SRC/viewer/package-lock.json" "$APP/viewer/"
cp "$SRC/setup-agents.sh" "$APP/"
chmod +x "$APP/setup-agents.sh" "$APP/scripts/"*
(cd "$APP/viewer" && PATH=$APP/node/bin:$PATH npm ci --omit=dev --silent --no-audit --no-fund)
(cd "$APP/mcp" && PATH=$APP/node/bin:$PATH npm ci --omit=dev --silent --no-audit --no-fund)
# Brave keeps running a cached background script unless its file name changes,
# even across version bumps, so every install gets a new name.
STAMP=$(date +%s)
mv "$APP/ridealong-cursor/background.js" "$APP/ridealong-cursor/background-$STAMP.js"
sed -i "s/\"background.js\"/\"background-$STAMP.js\"/; s/\"version\": \"\([0-9]*\.[0-9]*\)\.[0-9]*\"/\"version\": \"\1.$(( STAMP % 60000 ))\"/" "$APP/ridealong-cursor/manifest.json"
chmod -R a+rX "$APP"

echo "=== network"
TAILNET_HOST=
if [ "$NETWORK" = auto ] || [ "$NETWORK" = tailscale ]; then
  TAILNET_HOST=$(tailscale status --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d["Self"]["DNSName"].rstrip(".") if d.get("BackendState") == "Running" else "")' 2>/dev/null || true)
  if [ "$NETWORK" = tailscale ] && [ -z "$TAILNET_HOST" ]; then
    echo "Tailscale isn't connected. Run 'tailscale up', or use --network ssh."; exit 1
  fi
  [ -n "$TAILNET_HOST" ] && NETWORK=tailscale || NETWORK=ssh
fi

# The viewer stays on loopback unless --network lan asks otherwise; tailscale
# serve or an SSH tunnel reaches it there.
VIEWER_HOST=127.0.0.1
VIEWER_TOKEN=
OLD_TOKEN='' OLD_HOSTS='' OLD_NOTIFY=''
if [ -f "$APP/config.env" ]; then
  OLD_TOKEN=$(. "$APP/config.env"; echo "${VIEWER_TOKEN:-}")
  OLD_HOSTS=$(. "$APP/config.env"; echo "${ALLOWED_HOSTS:-}")
  OLD_NOTIFY=$(. "$APP/config.env"; echo "${NOTIFY_URL:-}")
fi
ALLOWED_HOSTS=$OLD_HOSTS
[ -n "$ALLOW_HOST" ] && ALLOWED_HOSTS=${ALLOWED_HOSTS:+$ALLOWED_HOSTS,}$ALLOW_HOST
NOTIFY_URL=${NOTIFY:-$OLD_NOTIFY}
case "$NETWORK" in
  tailscale) VIEWER_URL="https://$TAILNET_HOST:$HTTPS_PORT/" ;;
  ssh) VIEWER_URL="http://127.0.0.1:$VIEWER_PORT/" ;;
  lan)
    VIEWER_HOST=0.0.0.0
    VIEWER_TOKEN=${OLD_TOKEN:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}
    VIEWER_URL="http://$(hostname -I | awk '{print $1}'):$VIEWER_PORT/?token=$VIEWER_TOKEN"
    ;;
  *) echo "Unknown network: $NETWORK (use tailscale, ssh or lan)"; exit 2 ;;
esac

cat > "$APP/config.env" <<CONF
RIDEALONG_USER=$U
NETWORK_MODE=$NETWORK
VIEWER_HOST=$VIEWER_HOST
VIEWER_PORT=$VIEWER_PORT
HTTPS_PORT=$HTTPS_PORT
VIEWER_URL="$VIEWER_URL"
VIEWER_TOKEN=$VIEWER_TOKEN
ALLOWED_HOSTS=$ALLOWED_HOSTS
NOTIFY_URL="$NOTIFY_URL"
CONF
chown "root:$U" "$APP/config.env"
chmod 640 "$APP/config.env"

echo "=== systemd target and sleep"
# Some units are only pulled in by graphical.target; keep them starting at boot.
for w in $(systemctl list-dependencies graphical.target --plain --no-pager --depth=1 2>/dev/null | awk '{print $NF}' | grep -E '\.(service|path|timer|socket)$'); do
  [ "$w" = display-manager.service ] || systemctl add-wants multi-user.target "$w" 2>/dev/null || true
done
[ -f "$APP/default-target" ] || systemctl get-default > "$APP/default-target"
systemctl set-default multi-user.target
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

echo "=== XFCE config (no lock, no blanking, no first-run dialog)"
sudo -u "$U" -H bash <<'EOS'
set -euo pipefail
X=$HOME/.config/xfce4/xfconf/xfce-perchannel-xml
A=$HOME/.config/autostart
mkdir -p "$X" "$A"
install -d -m 700 "$HOME/.ridealong-browser"

for app in light-locker xfce4-screensaver xfce4-power-manager; do
  printf '[Desktop Entry]\nType=Application\nName=%s\nHidden=true\n' "$app" > "$A/$app.desktop"
done

# Without this the panel asks a question on first start.
[ -e "$X/xfce4-panel.xml" ] || cp /etc/xdg/xfce4/panel/default.xml "$X/xfce4-panel.xml"

cat > "$X/xfce4-session.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-session" version="1.0">
  <property name="General" type="empty">
    <property name="SaveOnExit" type="bool" value="false"/>
    <property name="AutoSave" type="bool" value="false"/>
    <property name="PromptOnLogout" type="bool" value="false"/>
  </property>
  <property name="shutdown" type="empty">
    <property name="LockScreen" type="bool" value="false"/>
  </property>
</channel>
XML

cat > "$X/xfce4-power-manager.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-power-manager" version="1.0">
  <property name="xfce4-power-manager" type="empty">
    <property name="dpms-enabled" type="bool" value="false"/>
    <property name="blank-on-ac" type="int" value="0"/>
    <property name="dpms-on-ac-sleep" type="uint" value="0"/>
    <property name="dpms-on-ac-off" type="uint" value="0"/>
    <property name="inactivity-on-ac" type="uint" value="14"/>
    <property name="lock-screen-suspend-hibernate" type="bool" value="false"/>
  </property>
</channel>
XML

cat > "$X/xfce4-screensaver.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-screensaver" version="1.0">
  <property name="saver" type="empty">
    <property name="enabled" type="bool" value="false"/>
  </property>
  <property name="lock" type="empty">
    <property name="enabled" type="bool" value="false"/>
  </property>
</channel>
XML
EOS

echo "=== helper scripts"
install -m 755 "$SRC/bin/ridealong-prestart" /usr/local/bin/ridealong-prestart
install -m 755 "$SRC/bin/ridealong-mcp" /usr/local/bin/ridealong-mcp
sed "s|@VIEWER_URL@|$VIEWER_URL|" "$SRC/bin/ridealong-status" > /usr/local/bin/ridealong-status
chmod 755 /usr/local/bin/ridealong-status

echo "=== systemd units"
if ss -tlnH "sport = :$VIEWER_PORT" | grep -q . && ! systemctl is-active -q ridealong-viewer; then
  echo "Port $VIEWER_PORT is in use. Pick another with --port."; exit 1
fi

# WantedBy=ridealong-display.service on the dependents: a service stopped through
# BindsTo is not revived by its own Restart=, so without it a real Xvfb crash
# (not a manual restart) would leave them stopped.
unit() { cat > "/etc/systemd/system/$1.service"; }

unit ridealong-display <<UNIT
[Unit]
Description=Ridealong: Xvfb display :99
StartLimitIntervalSec=0

[Service]
Type=simple
User=$U
Group=$U
Environment=HOME=$H
ExecStartPre=-/bin/rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -noreset
ExecStartPost=/bin/sh -c 'for i in \$\$(seq 100); do [ -S /tmp/.X11-unix/X99 ] && exit 0; sleep 0.1; done; exit 1'
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

unit ridealong-desktop <<UNIT
[Unit]
Description=Ridealong: XFCE session on :99
BindsTo=ridealong-display.service
After=ridealong-display.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$U
Group=$U
Environment=DISPLAY=:99
Environment=HOME=$H
ExecStart=/usr/bin/dbus-launch --exit-with-session /usr/bin/startxfce4
ExecStartPost=-/usr/bin/xset s off -dpms s noblank
ExecStartPost=-$APP/scripts/desktop-theme.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target ridealong-display.service
UNIT

unit ridealong-vnc <<UNIT
[Unit]
Description=Ridealong: x11vnc on 127.0.0.1:5900
BindsTo=ridealong-display.service
After=ridealong-display.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$U
Group=$U
Environment=DISPLAY=:99
Environment=HOME=$H
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -localhost -rfbport 5900 -nopw
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target ridealong-display.service
UNIT

# Not bound to the display: it reconnects on its own and keeps who-has-control.
unit ridealong-viewer <<UNIT
[Unit]
Description=Ridealong: viewer and control service
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$U
Group=$U
EnvironmentFile=$APP/config.env
Environment=HOME=$H
WorkingDirectory=$APP/viewer
ExecStart=$APP/node/bin/node $APP/viewer/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

unit ridealong-brave <<UNIT
[Unit]
Description=Ridealong: Brave with CDP on 127.0.0.1:9222
BindsTo=ridealong-display.service
After=ridealong-display.service ridealong-desktop.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$U
Group=$U
Environment=DISPLAY=:99
Environment=HOME=$H
ExecStartPre=/usr/local/bin/ridealong-prestart
ExecStart=/usr/bin/brave-browser --user-data-dir=$H/.ridealong-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --password-store=basic --no-first-run --no-default-browser-check --start-maximized --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --load-extension=$APP/ridealong-cursor ${BRAVE_FLAGS:-}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target ridealong-display.service
UNIT

systemctl daemon-reload
systemctl enable $SERVICES
systemctl restart ridealong-display ridealong-viewer
systemctl start $SERVICES

if [ "$NETWORK" = tailscale ]; then
  # Fails or hangs if the tailnet doesn't have HTTPS certificates turned on.
  if ! timeout 20 tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$VIEWER_PORT"; then
    echo "WARNING: tailscale serve failed. Turn on HTTPS at https://login.tailscale.com/admin/dns,"
    echo "then run: sudo tailscale serve --bg --https=$HTTPS_PORT http://127.0.0.1:$VIEWER_PORT"
  fi
fi

echo "=== agents"
sudo -u "$U" -H "$APP/setup-agents.sh" || echo "WARNING: agent setup failed; re-run $APP/setup-agents.sh"

status() { sudo -u "$U" /usr/local/bin/ridealong-status; }
wait_cdp() {
  for _ in $(seq 60); do
    curl -fsS -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "CDP did not come back within 60s"; return 1
}

FAILED=no
wait_cdp || FAILED=yes
if [ "$RUN_TESTS" = yes ]; then
  mkdir -p "$APP/shots"
  shot() { cp "$H/.cache/ridealong/display.png" "$APP/shots/$1.png" 2>/dev/null || true; }
  check() {
    echo "--- $1"; sleep 10; wait_cdp || FAILED=yes; sleep 6; status; shot "$1"
    for s in $SERVICES; do systemctl is-active -q "$s" || { echo "$s is DOWN"; FAILED=yes; }; done
  }
  echo "=== tests"
  check first-start
  systemctl restart ridealong-display; check display-restart
  kill -9 "$(systemctl show -p MainPID --value ridealong-display)"; check xvfb-crash
  pkill -9 brave || true; check brave-kill
  curl -fsS -o /dev/null -m 5 "http://127.0.0.1:$VIEWER_PORT/" || { echo "Viewer not answering"; FAILED=yes; }
fi

echo "=== exposure"
ss -tlnH | grep -E ":(5900|$VIEWER_PORT|9222)\b" || true
if command -v ufw >/dev/null; then ufw status | head -5 || true; fi

cat <<DONE

$([ "$FAILED" = no ] && echo "Ridealong is ready." || echo "Installed, but something failed. See $APP/install.log")

  Viewer:  $VIEWER_URL
DONE
case "$NETWORK" in
  ssh) cat <<DONE
  Tailscale isn't connected, so the viewer is private to this server.
  From your computer run:  ssh -L $VIEWER_PORT:127.0.0.1:$VIEWER_PORT $U@$(hostname)
  Then open the link above. Tailscale gives you an always-on link from any device.
DONE
    ;;
  lan) cat <<DONE
  Anyone on this network with that link controls a logged-in browser. Keep it secret.
DONE
    ;;
esac
cat <<DONE

  Next: in the viewer choose Control, sign into your accounts in Brave, then go back to Auto.
  Connect any other MCP client by pointing it at the command: ridealong-mcp
  Check it any time with: ridealong-status
DONE
[ "$FAILED" = no ]
