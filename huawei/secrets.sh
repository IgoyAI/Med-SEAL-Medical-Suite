#!/bin/bash
# ==============================================================================
# Kubernetes Secrets - Med-SEAL Suite (Huawei Cloud)
# ==============================================================================

set -euo pipefail

echo "============================================"
echo "  Med-SEAL Suite — Kubernetes Secrets"
echo "============================================"

# Ensure namespace exists
kubectl create namespace medseal 2>/dev/null || true

echo ""
read -sp "OpenEMR DB Password [default: openemr]: " OPENEMR_PASS
OPENEMR_PASS=${OPENEMR_PASS:-openemr}
echo ""

read -sp "Medplum DB Password [default: medplum]: " MEDPLUM_PASS
MEDPLUM_PASS=${MEDPLUM_PASS:-medplum}
echo ""

read -sp "SSO DB Password [default: sso_secret]: " SSO_PASS
SSO_PASS=${SSO_PASS:-sso_secret}
echo ""

read -sp "LLM API Key [leave empty if none]: " LLM_KEY
echo ""

# Create secrets
kubectl create secret generic openemr-db-pass \
  --namespace=medseal \
  --from-literal=password="${OPENEMR_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic medplum-db-pass \
  --namespace=medseal \
  --from-literal=password="${MEDPLUM_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic sso-db-pass \
  --namespace=medseal \
  --from-literal=password="${SSO_PASS}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic llm-api-key \
  --namespace=medseal \
  --from-literal=key="${LLM_KEY:-none}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "✅ Secrets created in namespace 'medseal'."
kubectl get secrets -n medseal
