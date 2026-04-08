#!/bin/bash
# ==============================================================================
# Huawei Cloud Setup Script - Med-SEAL Suite (CCE Standard)
# Region: ap-southeast-1 (Singapore)
# ==============================================================================
# Prerequisites: hcloud CLI configured with AK/SK
# Usage: ./setup.sh
# ==============================================================================

set -euo pipefail

REGION="ap-southeast-1"
AZ="${REGION}a"
CLUSTER_NAME="medseal-cluster"
VPC_NAME="medseal-vpc"
SUBNET_NAME="medseal-subnet"
SWR_ORG="medseal"
NODE_FLAVOR="s6.large.2"  # 2 vCPU, 4 GB RAM

echo "============================================"
echo "  Med-SEAL Suite — Huawei Cloud Setup"
echo "  Region: ${REGION}"
echo "============================================"

# ----------------------------------------------------------
# Step 1: Create VPC
# ----------------------------------------------------------
echo ""
echo "1. Creating VPC: ${VPC_NAME} ..."
VPC_ID=$(hcloud VPC CreateVpc \
  --cli-region="${REGION}" \
  --vpc.name="${VPC_NAME}" \
  --vpc.cidr="10.0.0.0/8" \
  --vpc.description="Med-SEAL Suite VPC" \
  2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$VPC_ID" ]; then
  echo "   VPC may already exist. Trying to find it..."
  VPC_ID=$(hcloud VPC ListVpcs \
    --cli-region="${REGION}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for v in data.get('vpcs', []):
    if v['name'] == '${VPC_NAME}':
        print(v['id'])
        break
" 2>/dev/null || echo "")
fi

echo "   VPC ID: ${VPC_ID}"

# ----------------------------------------------------------
# Step 2: Create Subnet
# ----------------------------------------------------------
echo ""
echo "2. Creating Subnet: ${SUBNET_NAME} ..."
SUBNET_ID=$(hcloud VPC CreateSubnet \
  --cli-region="${REGION}" \
  --subnet.name="${SUBNET_NAME}" \
  --subnet.cidr="10.0.0.0/16" \
  --subnet.gateway_ip="10.0.0.1" \
  --subnet.vpc_id="${VPC_ID}" \
  --subnet.availability_zone="${AZ}" \
  --subnet.primary_dns="100.125.1.250" \
  --subnet.secondary_dns="100.125.3.250" \
  2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$SUBNET_ID" ]; then
  echo "   Subnet may already exist. Trying to find it..."
  SUBNET_ID=$(hcloud VPC ListSubnets \
    --cli-region="${REGION}" \
    --vpc_id="${VPC_ID}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('subnets', []):
    if s['name'] == '${SUBNET_NAME}':
        print(s['id'])
        break
" 2>/dev/null || echo "")
fi

echo "   Subnet ID: ${SUBNET_ID}"

# ----------------------------------------------------------
# Step 3: Create CCE Cluster
# ----------------------------------------------------------
echo ""
echo "3. Creating CCE Standard Cluster: ${CLUSTER_NAME} ..."
echo "   (This may take 10-15 minutes...)"

CLUSTER_ID=$(hcloud CCE CreateCluster \
  --cli-region="${REGION}" \
  --cluster.metadata.name="${CLUSTER_NAME}" \
  --cluster.spec.type="VirtualMachine" \
  --cluster.spec.flavor="cce.s1.small" \
  --cluster.spec.version="v1.29" \
  --cluster.spec.hostNetwork.vpc="${VPC_ID}" \
  --cluster.spec.hostNetwork.subnet="${SUBNET_ID}" \
  --cluster.spec.containerNetwork.mode="overlay_l2" \
  --cluster.spec.containerNetwork.cidr="172.16.0.0/16" \
  --cluster.spec.kubernetesSvcIpRange="10.247.0.0/16" \
  --cluster.spec.description="Med-SEAL Healthcare Platform" \
  2>/dev/null | grep -o '"uid":"[^"]*"' | head -1 | cut -d'"' -f4)

echo "   Cluster ID: ${CLUSTER_ID}"
echo "   Waiting for cluster to become Available..."

# Poll for cluster readiness
for i in $(seq 1 60); do
  STATUS=$(hcloud CCE ShowCluster \
    --cli-region="${REGION}" \
    --cluster_id="${CLUSTER_ID}" \
    2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('status', {}).get('phase', 'Unknown'))
" 2>/dev/null || echo "Pending")
  if [ "$STATUS" = "Available" ]; then
    echo "   ✅ Cluster is Available!"
    break
  fi
  echo "   Status: ${STATUS} (${i}/60, retrying in 15s...)"
  sleep 15
done

# ----------------------------------------------------------
# Step 4: Create Node Pool (2 nodes)
# ----------------------------------------------------------
echo ""
echo "4. Creating Node Pool (2x ${NODE_FLAVOR})..."

hcloud CCE CreateNodePool \
  --cli-region="${REGION}" \
  --cluster_id="${CLUSTER_ID}" \
  --nodepool.metadata.name="medseal-pool" \
  --nodepool.spec.initialNodeCount=2 \
  --nodepool.spec.type="vm" \
  --nodepool.spec.nodeTemplate.flavor="${NODE_FLAVOR}" \
  --nodepool.spec.nodeTemplate.az="${AZ}" \
  --nodepool.spec.nodeTemplate.os="EulerOS 2.9" \
  --nodepool.spec.nodeTemplate.rootVolume.size=50 \
  --nodepool.spec.nodeTemplate.rootVolume.volumetype="SAS" \
  --nodepool.spec.nodeTemplate.dataVolumes.0.size=100 \
  --nodepool.spec.nodeTemplate.dataVolumes.0.volumetype="SAS" \
  --nodepool.spec.nodeTemplate.runtime.name="containerd" \
  2>/dev/null

echo "   ✅ Node pool created."

# ----------------------------------------------------------
# Step 5: Create SWR Organization
# ----------------------------------------------------------
echo ""
echo "5. Creating SWR Organization: ${SWR_ORG} ..."

hcloud SWR CreateOrganization \
  --cli-region="${REGION}" \
  --namespace="${SWR_ORG}" \
  2>/dev/null || echo "   Organization may already exist, continuing."

echo "   ✅ SWR org ready: swr.${REGION}.myhuaweicloud.com/${SWR_ORG}/"

# ----------------------------------------------------------
# Done
# ----------------------------------------------------------
echo ""
echo "============================================"
echo "  ✅  Infrastructure Setup Complete!"
echo "============================================"
echo ""
echo "VPC:      ${VPC_NAME} (${VPC_ID})"
echo "Subnet:   ${SUBNET_NAME} (${SUBNET_ID})"
echo "Cluster:  ${CLUSTER_NAME} (${CLUSTER_ID})"
echo "SWR:      swr.${REGION}.myhuaweicloud.com/${SWR_ORG}/"
echo ""
echo "Next steps:"
echo "  1. Download kubeconfig from CCE Console:"
echo "     CCE → ${CLUSTER_NAME} → Overview → Connection Information → kubectl"
echo "     Save to ~/.kube/config"
echo ""
echo "  2. Run: ./databases.sh   (provision RDS + DCS)"
echo "  3. Run: ./secrets.sh     (create K8s secrets)"
echo "  4. Run: ./push-images.sh (build & push to SWR)"
echo ""
