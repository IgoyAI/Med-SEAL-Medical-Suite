#!/bin/bash
# ==============================================================================
# Huawei Cloud Managed Databases - Med-SEAL Suite
# Region: ap-southeast-1 (Singapore) | Budget: ~$44/month
# ==============================================================================

set -euo pipefail

REGION="ap-southeast-1"
AZ="${REGION}a"

echo "============================================"
echo "  Med-SEAL Suite — Database Provisioning"
echo "  Region: ${REGION}"
echo "============================================"

# ----------------------------------------------------------
# Fetch VPC and Subnet IDs from setup.sh
# ----------------------------------------------------------
echo ""
echo "Fetching VPC and Subnet IDs..."

VPC_ID=$(hcloud VPC ListVpcs/v3 \
  --cli-region="${REGION}" \
  2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for v in data.get('vpcs', []):
    if v['name'] == 'medseal-vpc':
        print(v['id'])
        break
" 2>/dev/null)

SUBNET_ID=$(hcloud VPC ListSubnets \
  --cli-region="${REGION}" \
  --vpc_id="${VPC_ID}" \
  2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for s in data.get('subnets', []):
    if s['name'] == 'medseal-subnet':
        print(s['id'])
        break
" 2>/dev/null)

echo "   VPC:    ${VPC_ID}"
echo "   Subnet: ${SUBNET_ID}"

SG_ID=$(hcloud VPC ListSecurityGroups/v3 \
  --cli-region="${REGION}" \
  2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for sg in data.get('security_groups', []):
    print(sg['id'])
    break
" 2>/dev/null)
echo "   Security Group: ${SG_ID}"

# ----------------------------------------------------------
# 1. RDS MySQL 8.0 (OpenEMR)
# ----------------------------------------------------------
echo ""
echo "1. Creating RDS MySQL 8.0 (OpenEMR)..."

hcloud RDS CreateInstance \
  --cli-region="${REGION}" \
  --name="medseal-openemr-db" \
  --datastore.type="MySQL" \
  --datastore.version="8.0" \
  --flavor_ref="rds.mysql.c2.medium" \
  --volume.type="COMMON" \
  --volume.size=40 \
  --availability_zone="${AZ}" \
  --vpc_id="${VPC_ID}" \
  --subnet_id="${SUBNET_ID}" \
  --security_group_id="${SG_ID}" \
  --password="${RDS_PASSWORD:?Set RDS_PASSWORD env var}" \
  --region="${REGION}" \
  2>/dev/null || echo "   Check console if error"

# ----------------------------------------------------------
# 2. RDS PostgreSQL 16 (Medplum + SSO)
# ----------------------------------------------------------
echo ""
echo "2. Creating RDS PostgreSQL 16 (Medplum + SSO)..."

hcloud RDS CreateInstance \
  --cli-region="${REGION}" \
  --name="medseal-pg-db" \
  --datastore.type="PostgreSQL" \
  --datastore.version="16" \
  --flavor_ref="rds.pg.c2.medium" \
  --volume.type="COMMON" \
  --volume.size=40 \
  --availability_zone="${AZ}" \
  --vpc_id="${VPC_ID}" \
  --subnet_id="${SUBNET_ID}" \
  --security_group_id="${SG_ID}" \
  --password="${RDS_PASSWORD:?Set RDS_PASSWORD env var}" \
  --region="${REGION}" \
  2>/dev/null || echo "   Check console if error"

# ----------------------------------------------------------
# 3. DCS Redis 7.0 (Medplum cache)
# ----------------------------------------------------------
echo ""
echo "3. Creating DCS Redis 7.0 (Medplum cache)..."

hcloud DCS CreateInstance \
  --cli-region="${REGION}" \
  --name="medseal-redis" \
  --engine="Redis" \
  --engine_version="7.0" \
  --capacity=0.125 \
  --spec_code="redis.single.xu1.tiny.128" \
  --vpc_id="${VPC_ID}" \
  --subnet_id="${SUBNET_ID}" \
  --security_group_id="${SG_ID}" \
  --available_zones.0="${AZ}" \
  --no_password_access=true \
  2>/dev/null || echo "   Check console if error"

# ----------------------------------------------------------
echo ""
echo "============================================"
echo "  Databases provisioning started!"
echo "  Wait 10-15 min, then get private IPs from console."
echo "============================================"
echo ""
echo "Update k8s/ manifests with the private IPs."
echo ""
echo "Default passwords:"
echo "  MySQL/PG root: <set via RDS_PASSWORD>"
echo "  Redis: no password (VPC internal)"
