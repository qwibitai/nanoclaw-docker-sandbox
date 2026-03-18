#!/usr/bin/env bash
set -euo pipefail

# Inject iptables rules into the Docker runtime to block permissionApproval
# containers from reaching the internet directly.
#
# WHY THIS EXISTS
# ---------------
# permissionApproval containers must only reach the internet through the
# credential proxy (which gates all requests via Telegram approval). Without
# this, a tool that explicitly bypasses HTTP_PROXY (raw TCP, curl --noproxy,
# Python requests with proxies={}) could reach external services unilaterally.
#
# WHY NOT --internal
# ------------------
# Docker's --internal flag blocks all routing outside the bridge subnet,
# including the host.docker.internal tunnel that containers use to reach the
# credential proxy. On macOS Docker Desktop, the host tunnel goes via a
# userspace networking layer (gvisor/vpnkit) that is separate from iptables,
# so iptables DROP rules block internet access without affecting the tunnel.
#
# HOW IT WORKS
# ------------
# A privileged Alpine container (running inside the Docker Desktop VM on macOS,
# or directly on the host on Linux) adds rules to the DOCKER-USER iptables chain.
# DOCKER-USER is called from the FORWARD chain and is the recommended place for
# custom rules that Docker itself does not overwrite.
#
# Rules applied:
#   1. RETURN established/related (allow reply traffic for already-permitted flows)
#   2. RETURN DNS (UDP/TCP 53) — containers need name resolution
#   3. RETURN port 3001 — the credential proxy port
#   4. DROP everything else from the nanoclaw-proxy bridge interface
#
# PERSISTENCE
# -----------
# On macOS, Docker Desktop's Linux VM resets on Docker restart. Re-run this
# script after Docker Desktop restarts, or add it to your login items / launchd.
# On Linux, use iptables-persistent or add to the service startup.
#
# IDEMPOTENT: safe to run multiple times (checks for existing rules).

NETWORK_NAME="nanoclaw-proxy"
PROXY_PORT="${CREDENTIAL_PROXY_PORT:-3001}"

# Get the bridge interface name from the network ID
NETWORK_ID=$(docker network inspect "$NETWORK_NAME" --format '{{.Id}}' 2>/dev/null | head -c 12) || {
  echo "Error: nanoclaw-proxy network not found. Run scripts/setup-proxy-network.sh first."
  exit 1
}
BRIDGE_IF="br-${NETWORK_ID}"

echo "Applying iptables isolation for $NETWORK_NAME (bridge: $BRIDGE_IF, proxy port: $PROXY_PORT)"

docker run --rm --privileged --network host \
  alpine:3.18 sh -c "
    set -e
    apk add --no-cache --quiet iptables >/dev/null 2>&1

    # Skip if rules already applied (idempotent check)
    if iptables -C DOCKER-USER -i '$BRIDGE_IF' -j DROP 2>/dev/null; then
      echo 'iptables rules already in place, skipping'
      exit 0
    fi

    # Insert in reverse order (each -I 1 pushes to top, so last inserted = first matched)
    # Final order in chain:
    #   1. ESTABLISHED,RELATED → RETURN
    #   2. DNS UDP → RETURN
    #   3. DNS TCP → RETURN
    #   4. Proxy port → RETURN
    #   5. nanoclaw-proxy bridge → DROP
    iptables -I DOCKER-USER 1 -i '$BRIDGE_IF' -j DROP
    iptables -I DOCKER-USER 1 -i '$BRIDGE_IF' -p tcp --dport '$PROXY_PORT' -j RETURN
    iptables -I DOCKER-USER 1 -i '$BRIDGE_IF' -p tcp --dport 53 -j RETURN
    iptables -I DOCKER-USER 1 -i '$BRIDGE_IF' -p udp --dport 53 -j RETURN
    iptables -I DOCKER-USER 1 -m state --state ESTABLISHED,RELATED -j RETURN

    echo 'iptables isolation rules applied'
    iptables -L DOCKER-USER -n --line-numbers | head -20
  "
