#!/usr/bin/env bash
set -euo pipefail

# Production container deployment for EVIDIQ Cadence MCP (port 3018).
# The fleet's first stateful service: SQLite lives on a mounted volume —
# losing /root/evidiq-cadence-data loses customers' jobs (§7).
CONTAINER_NAME="evidiq-cadence"
IMAGE_NAME="evidiq-cadence:latest"
ENV_FILE="/root/evidiq-cadence.env"
HOST_PORT="3018"
DATA_DIR="/root/evidiq-cadence-data"

echo "Deploying ${CONTAINER_NAME} on host port ${HOST_PORT}..."

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: Environment file ${ENV_FILE} not found!"
  exit 1
fi

if [ ! -d "${DATA_DIR}" ]; then
  mkdir -p "${DATA_DIR}"
  chmod 700 "${DATA_DIR}"
  echo "Created data volume ${DATA_DIR}"
fi

docker stop "${CONTAINER_NAME}" 2>/dev/null || true
docker rm "${CONTAINER_NAME}" 2>/dev/null || true

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --network coolify \
  --env-file "${ENV_FILE}" \
  -p "127.0.0.1:${HOST_PORT}:3018" \
  -v "${DATA_DIR}:/data" \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.cadence.rule=Host(\`mcp.evidiq.dev\`) && PathPrefix(\`/cadence\`)" \
  --label "traefik.http.routers.cadence.tls=true" \
  --label "traefik.http.routers.cadence.tls.certresolver=letsencrypt" \
  --label "traefik.http.routers.cadence.middlewares=cadence-strip" \
  --label "traefik.http.middlewares.cadence-strip.stripprefix.prefixes=/cadence" \
  --label "traefik.http.services.cadence.loadbalancer.server.port=3018" \
  "${IMAGE_NAME}"

echo "Started ${CONTAINER_NAME}."
echo "Data volume: ${DATA_DIR} -> /data (CADENCE_DB_PATH=/data/cadence.db)"
