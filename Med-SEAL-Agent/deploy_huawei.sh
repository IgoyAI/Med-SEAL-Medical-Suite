#!/bin/bash
# ============================================================
# Med-SEAL Deployment Script for Huawei Cloud ECS
# Run this ON the ECS instance (119.13.90.82) as root
#
# SSH in:  ssh root@119.13.90.82  (password: MedSeal@2026!)
# Then:    bash deploy_huawei.sh
# ============================================================
set -e

echo "=== [1/6] Installing Docker ==="
if ! command -v docker &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose git
    systemctl enable docker
    systemctl start docker
    echo "Docker installed."
else
    echo "Docker already installed."
fi

echo "=== [2/6] Cloning Med-SEAL ==="
cd /opt
if [ -d "Med-SEAL" ]; then
    echo "Med-SEAL directory exists, pulling latest..."
    cd Med-SEAL && git pull 2>/dev/null || echo "Not a git repo, skipping pull."
    cd /opt
else
    echo "Creating Med-SEAL directory..."
    mkdir -p Med-SEAL
fi

echo "=== [3/6] Copying agent code ==="
# If running locally after scp, the code is already here.
# If not, you can git clone or scp the code manually.
if [ ! -f "/opt/Med-SEAL/agent/main.py" ]; then
    echo ""
    echo "ERROR: Agent code not found at /opt/Med-SEAL/agent/main.py"
    echo "Please copy the code first:"
    echo "  scp -r agent/ requirements.txt Dockerfile root@119.13.90.82:/opt/Med-SEAL/"
    echo ""
    exit 1
fi

echo "=== [4/6] Creating .env file ==="
cat > /opt/Med-SEAL/.env << 'ENVEOF'
# SEA-LION (powers 5 agents + guard)
MEDSEAL_SEALION_API_URL=https://api.sea-lion.ai/v1
MEDSEAL_SEALION_API_KEY=<your-sealion-key>
MEDSEAL_SEALION_MODEL=aisingapore/Qwen-SEA-LION-v4-32B-IT
MEDSEAL_SEAGUARD_MODEL=aisingapore/SEA-Guard

# Clinical LLM (OpenRouter)
MEDSEAL_CLINICAL_LLM_BACKEND=openrouter
MEDSEAL_OPENROUTER_API_KEY=<your-openrouter-key>
MEDSEAL_OPENROUTER_MODEL=qwen/qwen3.6-plus:free

# Medplum FHIR R4
MEDSEAL_MEDPLUM_URL=http://localhost:8103/fhir/R4
MEDSEAL_MEDPLUM_EMAIL=admin@example.com
MEDSEAL_MEDPLUM_PASSWORD=medplum_admin

# Session
MEDSEAL_SESSION_TTL_SECONDS=86400
ENVEOF
echo ".env created."

echo "=== [5/6] Building Docker image ==="
cd /opt/Med-SEAL
docker build -t medseal-agent:latest .
echo "Docker image built."

echo "=== [6/6] Starting container ==="
# Stop any existing container
docker stop medseal-agent 2>/dev/null || true
docker rm medseal-agent 2>/dev/null || true

docker run -d \
    --name medseal-agent \
    --restart unless-stopped \
    -p 8000:8000 \
    --env-file /opt/Med-SEAL/.env \
    medseal-agent:latest

echo ""
echo "============================================"
echo " Med-SEAL Agent deployed successfully!"
echo " URL: http://119.13.90.82:8000"
echo " Docs: http://119.13.90.82:8000/docs"
echo " Health: http://119.13.90.82:8000/health"
echo "============================================"
echo ""
docker logs -f medseal-agent
