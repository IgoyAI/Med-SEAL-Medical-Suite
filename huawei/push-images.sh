#!/bin/bash
# ==============================================================================
# Huawei SWR Image Push - Med-SEAL Suite
# Region: ap-southeast-1 (Singapore)
# ==============================================================================

set -euo pipefail

REGION="ap-southeast-1"
SWR_URL="swr.${REGION}.myhuaweicloud.com"
ORG="medseal"

echo "============================================"
echo "  Med-SEAL Suite — Build & Push to SWR"
echo "  Registry: ${SWR_URL}/${ORG}/"
echo "============================================"

# ----------------------------------------------------------
# Step 1: Docker login to SWR
# ----------------------------------------------------------
echo ""
echo "1. Logging in to SWR..."
echo "   Go to: Huawei Cloud Console → SWR → Dashboard → Generate Login Command"
echo "   Or run the command below (replace with your login command):"
echo ""

# Try to get login command via hcloud
SWR_LOGIN=$(hcloud SWR CreateLoginCommand \
  --cli-region="${REGION}" \
  2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('login', ''))
" 2>/dev/null || echo "")

if [ -n "$SWR_LOGIN" ]; then
  echo "   Running auto-generated login command..."
  eval "$SWR_LOGIN"
else
  echo "   ⚠️  Could not auto-generate login. Please run manually:"
  echo "   docker login -u ${REGION}@<AK> -p <Login_Key> ${SWR_URL}"
  echo ""
  read -p "   Press Enter after logging in to Docker..."
fi

# ----------------------------------------------------------
# Step 2: Build images (linux/amd64 for CCE nodes)
# ----------------------------------------------------------
echo ""
echo "2. Building ai-service..."
docker build --platform linux/amd64 \
  -t ${SWR_URL}/${ORG}/ai-service:latest \
  ../apps/ai-service

echo ""
echo "3. Building ai-frontend..."
docker build --platform linux/amd64 \
  -t ${SWR_URL}/${ORG}/ai-frontend:latest \
  ../apps/ai-frontend

echo ""
echo "4. Building cdss..."
docker build --platform linux/amd64 \
  -t ${SWR_URL}/${ORG}/cdss:latest \
  ../apps/cdss

# ----------------------------------------------------------
# Step 3: Push images
# ----------------------------------------------------------
echo ""
echo "5. Pushing ai-service..."
docker push ${SWR_URL}/${ORG}/ai-service:latest

echo ""
echo "6. Pushing ai-frontend..."
docker push ${SWR_URL}/${ORG}/ai-frontend:latest

echo ""
echo "7. Pushing cdss..."
docker push ${SWR_URL}/${ORG}/cdss:latest

echo ""
echo "============================================"
echo "  ✅  Images pushed successfully!"
echo "============================================"
echo "  AI Service:  ${SWR_URL}/${ORG}/ai-service:latest"
echo "  AI Frontend: ${SWR_URL}/${ORG}/ai-frontend:latest"
echo "  CDSS:        ${SWR_URL}/${ORG}/cdss:latest"
echo ""
echo "  These paths are already set in the k8s/ manifests."
