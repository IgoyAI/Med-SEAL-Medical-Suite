#!/bin/bash
# ==============================================================================
# Med-SEAL Suite — Huawei Cloud ECS + Docker Compose Deployment
# Region: ap-southeast-1 (Singapore)
# Budget: ~$90-100/month
# ==============================================================================
# Prerequisites:
#   1. hcloud CLI installed and configured (hcloud configure init)
#   2. SSH key pair created in Huawei Console (or we create one below)
# ==============================================================================

set -euo pipefail

REGION="ap-southeast-1"
AZ="${REGION}a"
ECS_NAME="medseal-server"
VPC_NAME="medseal-vpc"
SUBNET_NAME="medseal-subnet"
SG_NAME="medseal-sg"
ECS_FLAVOR="s6.xlarge.2"  # 4 vCPU, 8 GB RAM — good balance of cost/performance
IMAGE_NAME="Ubuntu 22.04 server 64bit"
DISK_SIZE=100  # GB SSD for system + data
KEYPAIR_NAME="medseal-key"

echo "============================================"
echo "  Med-SEAL Suite — ECS Deployment"
echo "  Region: ${REGION}"
echo "  Flavor: ${ECS_FLAVOR} (4 vCPU, 8 GB)"
echo "============================================"

# ----------------------------------------------------------
# Step 1: Create VPC
# ----------------------------------------------------------
echo ""
echo "1. Creating VPC: ${VPC_NAME} ..."
VPC_RESULT=$(hcloud VPC CreateVpc \
  --cli-region="${REGION}" \
  --vpc.name="${VPC_NAME}" \
  --vpc.cidr="192.168.0.0/16" \
  --vpc.description="Med-SEAL Suite VPC" \
  2>&1) || true

VPC_ID=$(echo "$VPC_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('vpc', {}).get('id', ''))
except: pass
" 2>/dev/null || echo "")

if [ -z "$VPC_ID" ]; then
  echo "   VPC may already exist, looking it up..."
  VPC_ID=$(hcloud VPC ListVpcs \
    --cli-region="${REGION}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for v in data.get('vpcs', []):
    if v['name'] == '${VPC_NAME}':
        print(v['id']); break
" 2>/dev/null || echo "")
fi

if [ -z "$VPC_ID" ]; then
  echo "   ERROR: Could not create or find VPC. Check hcloud configure init."
  exit 1
fi
echo "   VPC ID: ${VPC_ID}"

# ----------------------------------------------------------
# Step 2: Create Subnet
# ----------------------------------------------------------
echo ""
echo "2. Creating Subnet: ${SUBNET_NAME} ..."
sleep 3  # Wait for VPC to be ready

SUBNET_RESULT=$(hcloud VPC CreateSubnet \
  --cli-region="${REGION}" \
  --subnet.name="${SUBNET_NAME}" \
  --subnet.cidr="192.168.0.0/24" \
  --subnet.gateway_ip="192.168.0.1" \
  --subnet.vpc_id="${VPC_ID}" \
  --subnet.primary_dns="100.125.1.250" \
  --subnet.secondary_dns="100.125.3.250" \
  2>&1) || true

SUBNET_ID=$(echo "$SUBNET_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('subnet', {}).get('id', ''))
except: pass
" 2>/dev/null || echo "")

if [ -z "$SUBNET_ID" ]; then
  echo "   Subnet may already exist, looking it up..."
  SUBNET_ID=$(hcloud VPC ListSubnets \
    --cli-region="${REGION}" \
    --vpc_id="${VPC_ID}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('subnets', []):
    if s['name'] == '${SUBNET_NAME}':
        print(s['id']); break
" 2>/dev/null || echo "")
fi

echo "   Subnet ID: ${SUBNET_ID}"

# ----------------------------------------------------------
# Step 3: Create Security Group
# ----------------------------------------------------------
echo ""
echo "3. Creating Security Group: ${SG_NAME} ..."

SG_RESULT=$(hcloud VPC CreateSecurityGroup \
  --cli-region="${REGION}" \
  --security_group.name="${SG_NAME}" \
  --security_group.description="Med-SEAL Suite ports" \
  2>&1) || true

SG_ID=$(echo "$SG_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('security_group', {}).get('id', ''))
except: pass
" 2>/dev/null || echo "")

if [ -z "$SG_ID" ]; then
  SG_ID=$(hcloud VPC ListSecurityGroups \
    --cli-region="${REGION}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for sg in data.get('security_groups', []):
    if sg['name'] == '${SG_NAME}':
        print(sg['id']); break
" 2>/dev/null || echo "")
fi

echo "   Security Group ID: ${SG_ID}"

# Add rules: SSH(22), HTTP(80), HTTPS(443), and app ports
echo "   Adding firewall rules..."
for PORT in 22 80 443 3000 3001 4003 8080 8081 8103; do
  hcloud VPC CreateSecurityGroupRule \
    --cli-region="${REGION}" \
    --security_group_rule.security_group_id="${SG_ID}" \
    --security_group_rule.direction="ingress" \
    --security_group_rule.ethertype="IPv4" \
    --security_group_rule.protocol="tcp" \
    --security_group_rule.port_range_min=${PORT} \
    --security_group_rule.port_range_max=${PORT} \
    --security_group_rule.remote_ip_prefix="0.0.0.0/0" \
    2>/dev/null || true
done
echo "   Ports opened: 22, 80, 443, 3000, 3001, 4003, 8080, 8081, 8103"

# ----------------------------------------------------------
# Step 4: Create SSH Key Pair
# ----------------------------------------------------------
echo ""
echo "4. Creating SSH Key Pair: ${KEYPAIR_NAME} ..."

KEYPAIR_RESULT=$(hcloud ECS NovaCreateKeypair \
  --cli-region="${REGION}" \
  --keypair.name="${KEYPAIR_NAME}" \
  2>&1) || true

PRIVATE_KEY=$(echo "$KEYPAIR_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('keypair', {}).get('private_key', ''))
except: pass
" 2>/dev/null || echo "")

if [ -n "$PRIVATE_KEY" ]; then
  echo "$PRIVATE_KEY" > ~/.ssh/medseal-huawei.pem
  chmod 600 ~/.ssh/medseal-huawei.pem
  echo "   Private key saved to: ~/.ssh/medseal-huawei.pem"
else
  echo "   Key pair may already exist (reusing existing)."
  echo "   If you don't have the private key, delete and recreate via Console."
fi

# ----------------------------------------------------------
# Step 5: Find Ubuntu Image ID
# ----------------------------------------------------------
echo ""
echo "5. Finding Ubuntu 22.04 image..."

IMAGE_ID=$(hcloud IMS ListImages \
  --cli-region="${REGION}" \
  --__imagetype="gold" \
  --name="Ubuntu 22.04 server 64bit" \
  2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for img in data.get('images', []):
    if 'Ubuntu' in img.get('name','') and '22.04' in img.get('name',''):
        print(img['id']); break
" 2>/dev/null || echo "")

if [ -z "$IMAGE_ID" ]; then
  echo "   Exact match not found, trying broader search..."
  IMAGE_ID=$(hcloud IMS ListImages \
    --cli-region="${REGION}" \
    --__imagetype="gold" \
    --__platform="Ubuntu" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for img in data.get('images', []):
    if '22.04' in img.get('name',''):
        print(img['id']); break
" 2>/dev/null || echo "")
fi

echo "   Image ID: ${IMAGE_ID}"

# ----------------------------------------------------------
# Step 6: Create ECS Instance
# ----------------------------------------------------------
echo ""
echo "6. Creating ECS instance: ${ECS_NAME} (${ECS_FLAVOR})..."

# Get network ID for the subnet
NETWORK_ID=$(hcloud VPC ListSubnets \
  --cli-region="${REGION}" \
  --vpc_id="${VPC_ID}" \
  2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('subnets', []):
    if s['name'] == '${SUBNET_NAME}':
        print(s.get('neutron_network_id', s.get('id', ''))); break
" 2>/dev/null || echo "$SUBNET_ID")

ECS_RESULT=$(hcloud ECS CreateServers \
  --cli-region="${REGION}" \
  --server.name="${ECS_NAME}" \
  --server.availability_zone="${AZ}" \
  --server.flavorRef="${ECS_FLAVOR}" \
  --server.imageRef="${IMAGE_ID}" \
  --server.key_name="${KEYPAIR_NAME}" \
  --server.vpcid="${VPC_ID}" \
  --server.nics.0.subnet_id="${NETWORK_ID}" \
  --server.security_groups.0.id="${SG_ID}" \
  --server.root_volume.volumetype="SSD" \
  --server.root_volume.size=${DISK_SIZE} \
  --server.publicip.eip.iptype="5_bgp" \
  --server.publicip.eip.bandwidth.size=5 \
  --server.publicip.eip.bandwidth.sharetype="PER" \
  --server.publicip.eip.bandwidth.chargemode="traffic" \
  --server.count=1 \
  2>&1)

echo "$ECS_RESULT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    job_id = data.get('job_id', 'unknown')
    server_ids = data.get('serverIds', [])
    print(f'   Job ID: {job_id}')
    print(f'   Server ID: {server_ids[0] if server_ids else \"pending\"}')
except Exception as e:
    print(f'   Response: {sys.stdin.read()}')
" 2>/dev/null || echo "   Submitted. Check console for status."

# ----------------------------------------------------------
# Step 7: Wait and get public IP
# ----------------------------------------------------------
echo ""
echo "7. Waiting for ECS to be ready (may take 2-5 minutes)..."
echo "   Checking every 15 seconds..."

PUBLIC_IP=""
for i in $(seq 1 20); do
  sleep 15
  PUBLIC_IP=$(hcloud ECS ListServersDetails \
    --cli-region="${REGION}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('servers', []):
    if s['name'] == '${ECS_NAME}' and s.get('status') == 'ACTIVE':
        for net in s.get('addresses', {}).values():
            for addr in net:
                if addr.get('OS-EXT-IPS:type') == 'floating':
                    print(addr['addr']); break
" 2>/dev/null || echo "")

  if [ -n "$PUBLIC_IP" ]; then
    echo "   ECS is ACTIVE!"
    break
  fi
  echo "   Still provisioning... (${i}/20)"
done

if [ -z "$PUBLIC_IP" ]; then
  echo "   Timed out waiting. Check Huawei Console for the public IP."
  echo "   Then run: ./setup-server.sh <PUBLIC_IP>"
  exit 1
fi

echo ""
echo "============================================"
echo "  ECS Ready!"
echo "============================================"
echo ""
echo "  Public IP:  ${PUBLIC_IP}"
echo "  SSH Key:    ~/.ssh/medseal-huawei.pem"
echo ""
echo "  Next step — set up Docker and deploy:"
echo "    ./setup-server.sh ${PUBLIC_IP}"
echo ""
