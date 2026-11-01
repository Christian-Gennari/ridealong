#!/bin/bash
# Dark desktop, panels out of the way. Run as the agent user once XFCE is up.
for _ in $(seq 50); do pid=$(pgrep -u "$(id -un)" -x xfce4-panel | head -1); [ -n "$pid" ] && break; sleep 0.2; done
[ -n "$pid" ] || { echo "XFCE panel not running; skipping theme"; exit 0; }
export DBUS_SESSION_BUS_ADDRESS DISPLAY=:99
DBUS_SESSION_BUS_ADDRESS=$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')
set_prop() { xfconf-query -c "$1" -p "$2" -n -t "$3" -s "$4"; }
set_prop xsettings /Net/ThemeName string Adwaita-dark
set_prop xfwm4 /general/theme string Default
set_prop xfce4-desktop /backdrop/screen0/monitorscreen/workspace0/color-style int 0
set_prop xfce4-desktop /backdrop/screen0/monitorscreen/workspace0/image-style int 0
set_prop xfce4-desktop /backdrop/screen0/monitorscreen/workspace0/rgba1 string '#0c0d0f'
xfconf-query -c xfce4-desktop -p /backdrop/screen0/monitorscreen/workspace0/rgba1 -r 2>/dev/null
xfconf-query -c xfce4-desktop -p /backdrop/screen0/monitorscreen/workspace0/rgba1 -n -a -t double -s 0.047 -t double -s 0.051 -t double -s 0.059 -t double -s 1
for panel in $(xfconf-query -c xfce4-panel -p /panels 2>/dev/null | grep -E '^[0-9]+$'); do
  set_prop xfce4-panel "/panels/panel-$panel/autohide-behavior" uint 2
done
