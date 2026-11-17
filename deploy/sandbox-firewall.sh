#!/usr/bin/env bash
# Host firewall for the sandbox platform network (SBX-03, ADR-0010). An internal docker network has
# no route out, but containers on it can still open connections to the HOST itself — to every
# service listening on 0.0.0.0 (database, SSH, …). This allows only the platform port from that
# network's bridge and drops the rest. Idempotent; run as root after the platform has created the
# network (or after `docker network create --internal "$SANDBOX_NETWORK"`), and again after reboots
# (iptables rules are not persistent: use iptables-persistent / a systemd unit).
#
#   SANDBOX_NETWORK=ap-sandbox PORT=3000 deploy/sandbox-firewall.sh
set -euo pipefail
NET="${SANDBOX_NETWORK:?set SANDBOX_NETWORK}"
PORT="${PORT:-3000}"
id="$(docker network inspect -f '{{.Id}}' "$NET")"
custom="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NET" 2>/dev/null || true)"
if [ -n "$custom" ] && [ "$custom" != "<no value>" ]; then br="$custom"; else br="br-${id:0:12}"; fi
[ -d "/sys/class/net/$br" ] || { echo "bridge $br not found for $NET" >&2; exit 1; }

iptables -N AP-SANDBOX 2>/dev/null || true
iptables -F AP-SANDBOX
iptables -A AP-SANDBOX -p tcp --dport "$PORT" -j ACCEPT
iptables -A AP-SANDBOX -j DROP
iptables -C INPUT -i "$br" -j AP-SANDBOX 2>/dev/null || iptables -I INPUT 1 -i "$br" -j AP-SANDBOX
echo "sandbox firewall: $NET ($br) → only tcp/$PORT on this host"
