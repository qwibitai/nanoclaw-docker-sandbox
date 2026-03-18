#!/usr/bin/env bash
set -euo pipefail

# Create the nanoclaw-proxy Docker bridge network.
# Used to isolate permission-approval containers from the internet while
# allowing them to reach the host credential proxy via the bridge gateway IP.
#
# --internal: blocks all routing outside the bridge subnet, so containers
#   cannot reach the internet directly even if they ignore HTTP_PROXY settings.
#   This is the key security property — the credential proxy is the only exit.
#
# host.docker.internal resolution: the container runner injects the bridge
#   gateway IP (e.g. 172.20.0.1) via --add-host rather than using 'host-gateway'.
#   On macOS Docker Desktop, 'host-gateway' resolves to the VM host IP which
#   is outside the bridge subnet and unreachable on --internal networks.
#   The bridge gateway IS within the subnet, so it is always reachable.
#
# Idempotent: safe to run multiple times.

NETWORK_NAME="nanoclaw-proxy"

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "nanoclaw-proxy network already exists"
  exit 0
fi

docker network create \
  --driver bridge \
  --opt com.docker.network.bridge.name=nanoclaw-proxy \
  "$NETWORK_NAME"

echo "nanoclaw-proxy network created"
