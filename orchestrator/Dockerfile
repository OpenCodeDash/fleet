# Portable orchestrator image: a plain Node app that drives a NixOS fleet host over SSH.
#
# Build from the orchestrator directory:
#   docker build -t fleet-orchestrator -f orchestrator/Dockerfile orchestrator
#
# Run (mount an SSH key for the fleet host and a clone of the target repo):
#   docker run --rm \
#     -v ~/.ssh/id_ed25519:/root/.ssh/id_ed25519:ro \
#     -v /srv/fleet-demo:/srv/fleet-demo \
#     -e FLEET_BOARD_URL=... -e FLEET_BOARD_ID=... -e FLEET_BOARD_TOKEN=... \
#     -e FLEET_SSH_HOST=fleet-host -e FLEET_SSH_USER=root \
#     -e FLEET_CATALOG=/app/examples/demo-catalog.json \
#     -e FLEET_REPO_DIR=/srv/fleet-demo -e FLEET_REPO=https://github.com/you/repo.git \
#     -e FLEET_PROMPT='...' \
#     -e FLEET_MODEL_PROVIDER=router -e FLEET_MODEL_ID=basic \
#     -e FLEET_INJECT_GITHUB_TOKEN=ghp_... \
#     -e FLEET_INJECT_OPENCODE_CONFIG_CONTENT='{...}' \
#     fleet-orchestrator run 128 author

FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY examples ./examples

# Configuration is entirely FLEET_* env (see docs/setup.md). The orchestrator reaches each
# container's host-private port through an SSH tunnel, so `ssh` must be able to reach
# FLEET_SSH_HOST with the mounted key.
ENTRYPOINT ["node", "src/main.ts"]
