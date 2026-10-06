#!/usr/bin/env bash
# Turn automatic updates on (or off) for OpennJob on this server, as root:
#
#   bash /opt/opennjob/deploy/enable-auto-update.sh          # on: check every 10 minutes
#   bash /opt/opennjob/deploy/enable-auto-update.sh off      # off
#
# What it runs is deploy/auto-update.sh: it installs a newly pushed version and goes back to the
# previous one if the new one does not pass its health check. History: journalctl -u opennjob-update
set -euo pipefail
DIR="${OPENNJOB_DIR:-/opt/opennjob}"
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
[ -x "$DIR/oj" ] || { echo "OpennJob is not installed in $DIR (run deploy/install-hostinger.sh first)." >&2; exit 1; }

if [ "${1:-on}" = off ]; then
  systemctl disable --now opennjob-update.timer 2>/dev/null || true
  rm -f /etc/systemd/system/opennjob-update.timer /etc/systemd/system/opennjob-update.service
  systemctl daemon-reload
  echo "Automatic updates are off. Update by hand: cd $DIR && git pull && ./oj up -d --build"
  exit 0
fi

cat > /etc/systemd/system/opennjob-update.service <<UNIT
[Unit]
Description=Install a new version of OpennJob if one was pushed (rolls back if unhealthy)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=OPENNJOB_DIR=$DIR
ExecStart=/bin/bash $DIR/deploy/auto-update.sh
TimeoutStartSec=30min
UNIT

cat > /etc/systemd/system/opennjob-update.timer <<UNIT
[Unit]
Description=Check for a new version of OpennJob every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now opennjob-update.timer
echo "Automatic updates are on: every 10 minutes, with rollback if a new version is unhealthy."
echo "Run one now:   systemctl start opennjob-update.service"
echo "See history:   journalctl -u opennjob-update --since today"
systemctl list-timers opennjob-update.timer --no-pager | head -3
