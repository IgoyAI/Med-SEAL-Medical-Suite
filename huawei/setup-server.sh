#!/bin/bash
# ==============================================================================
# Med-SEAL Suite — Remote Server Setup (Docker Compose)
# Run this AFTER deploy-ecs.sh gives you the public IP
# Usage: ./setup-server.sh <PUBLIC_IP>
# ==============================================================================

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./setup-server.sh <PUBLIC_IP>"
  echo "Example: ./setup-server.sh 119.8.123.45"
  exit 1
fi

PUBLIC_IP="$1"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/medseal-huawei.pem}"
SSH_USER="root"
SSH_CMD="ssh -o StrictHostKeyChecking=no -i ${SSH_KEY} ${SSH_USER}@${PUBLIC_IP}"
REPO_URL="${REPO_URL:-https://github.com/user/Med-SEAL-Suite.git}"  # Update with your repo

echo "============================================"
echo "  Med-SEAL Suite — Server Setup"
echo "  Target: ${PUBLIC_IP}"
echo "============================================"

# ----------------------------------------------------------
# Step 1: Install Docker + Docker Compose
# ----------------------------------------------------------
echo ""
echo "1. Installing Docker..."
$SSH_CMD << 'REMOTE_SCRIPT'
set -e

# Update and install prerequisites
apt-get update -qq
apt-get install -y -qq curl git

# Install Docker
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  echo "Docker installed."
else
  echo "Docker already installed."
fi

# Verify
docker --version
docker compose version
REMOTE_SCRIPT

echo "   Docker ready."

# ----------------------------------------------------------
# Step 2: Clone repository
# ----------------------------------------------------------
echo ""
echo "2. Deploying Med-SEAL Suite..."
$SSH_CMD << REMOTE_SCRIPT
set -e

# Clone or update repo
if [ -d /opt/medseal ]; then
  echo "Repo exists, pulling latest..."
  cd /opt/medseal && git pull || true
else
  echo "Cloning repository..."
  git clone ${REPO_URL} /opt/medseal || {
    echo ""
    echo "============================================"
    echo "  Git clone failed. Trying rsync instead..."
    echo "============================================"
    mkdir -p /opt/medseal
  }
fi
REMOTE_SCRIPT

# If git clone might fail (private repo), rsync the files
echo "   Syncing project files via rsync..."
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
rsync -avz --progress \
  -e "ssh -o StrictHostKeyChecking=no -i ${SSH_KEY}" \
  --exclude node_modules \
  --exclude .git \
  --exclude "*.tar.gz" \
  --exclude google-cloud-sdk \
  --exclude scripts/output \
  "${SCRIPT_DIR}/" \
  "${SSH_USER}@${PUBLIC_IP}:/opt/medseal/"

echo "   Files synced."

# ----------------------------------------------------------
# Step 3: Start services
# ----------------------------------------------------------
echo ""
echo "3. Starting Med-SEAL Suite..."
$SSH_CMD << 'REMOTE_SCRIPT'
set -e
cd /opt/medseal

# Start all services
docker compose pull
docker compose up -d

# Wait for services to initialize
echo ""
echo "Waiting 30s for services to start..."
sleep 30

# Show status
docker compose ps
REMOTE_SCRIPT

# ----------------------------------------------------------
# Done
# ----------------------------------------------------------
echo ""
echo "============================================"
echo "  Med-SEAL Suite is LIVE!"
echo "============================================"
echo ""
echo "  Access points:"
echo "    AI Frontend:  http://${PUBLIC_IP}:3001"
echo "    OpenEMR:      http://${PUBLIC_IP}:8080"
echo "    Medplum API:  http://${PUBLIC_IP}:8103"
echo "    Medplum App:  http://${PUBLIC_IP}:3000"
echo "    AI Service:   http://${PUBLIC_IP}:4003"
echo ""
echo "  SSH access:"
echo "    ssh -i ${SSH_KEY} ${SSH_USER}@${PUBLIC_IP}"
echo ""
echo "  View logs:"
echo "    ssh -i ${SSH_KEY} ${SSH_USER}@${PUBLIC_IP} 'cd /opt/medseal && docker compose logs -f'"
echo ""
