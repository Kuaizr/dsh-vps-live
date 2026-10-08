#!/bin/sh
# Example desktop-live session script: wallpaper + compositor + dwm.
# Point your desktop-wm systemd unit at this file (see README).
: "${DISPLAY:=:99}"
export DISPLAY
: "${HOME:=/home/dsh}"
export HOME

WALLPAPER="${WALLPAPER:-$HOME/.config/desktop-live/wallpaper.png}"

[ -f "$WALLPAPER" ] && feh --bg-fill "$WALLPAPER" &
[ -x /usr/bin/picom ] && picom -b --config /dev/null &

# dwm status bar: host + clock
while true; do
  xsetroot -name " $(hostname) | $(date '+%a %b %d %H:%M') "
  sleep 30
done &

exec dwm
