# Med-SEAL Suite — Huawei Cloud Deployment (CCE)

Deploy Med-SEAL Suite to Huawei Cloud using CCE (Cloud Container Engine), RDS (managed databases), DCS (Redis), and SWR (container registry).

**Region:** `ap-southeast-1` (Singapore)

## Prerequisites

1. [Huawei Cloud Account](https://www.huaweicloud.com/intl/en-us/) with real-name authentication completed
2. Install **KooCLI** (`hcloud`) — Huawei Cloud CLI:
   ```bash
   # macOS (Apple Silicon)
   curl -LO "https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/huaweicloud-cli-mac-arm64.tar.gz"
   tar -zxvf huaweicloud-cli-mac-arm64.tar.gz
   sudo mv hcloud /usr/local/bin/

   # Or one-liner auto-install:
   curl -sSL https://cn-north-4-hdn-koocli.obs.cn-north-4.myhuaweicloud.com/cli/latest/hcloud_install.sh | bash -s -- -y
   ```
3. Configure `hcloud`:
   ```bash
   hcloud configure init
   # → Access Key ID (AK)
   # → Secret Access Key (SK)
   # → Region: ap-southeast-1
   ```
   Get AK/SK from: Console → username → My Credentials → Access Keys → Create
4. Install `kubectl`: https://kubernetes.io/docs/tasks/tools/
5. Install Docker (for building images)

## Deployment Steps

### Step 1: Bootstrap Infrastructure
Creates VPC, subnet, CCE cluster, and SWR organization.
```bash
./setup.sh
```

### Step 2: Create Managed Databases
Provisions RDS MySQL (OpenEMR), RDS PostgreSQL (Medplum + SSO), and DCS Redis.
```bash
./databases.sh
```
> **IMPORTANT:** After running, the script prints **private IPs** for each database.
> You MUST update these IPs in the K8s manifests:
> - `k8s/openemr.yaml` → `MYSQL_HOST`
> - `k8s/medplum.yaml` → `POSTGRES_HOST` and `REDIS_HOST`
> - `k8s/ai-service.yaml` → DB connection strings
> - `k8s/sync-service.yaml` → DB connection strings

### Step 3: Configure Secrets
Creates Kubernetes secrets for passwords and API keys.
```bash
./secrets.sh
```

### Step 4: Build & Push Docker Images
Builds `ai-service` and `ai-frontend`, pushes to Huawei SWR.
```bash
./push-images.sh
```

### Step 5: Connect kubectl & Deploy
```bash
# Download kubeconfig from CCE Console:
# CCE Console → medseal-cluster → Overview → Connection Information → kubectl → Download
# Save to ~/.kube/config

# Verify connection
kubectl cluster-info

# Create namespace
kubectl apply -f k8s/namespace.yaml

# Deploy all services
kubectl apply -f k8s/ -n medseal

# Watch for pods
kubectl get pods -n medseal -w
```

### Step 6: Get the ELB Public IP
```bash
kubectl get ingress medseal-ingress -n medseal
```
The `ADDRESS` column shows your ELB public IP. Update DNS or use nip.io:
```
http://app.medseal.<ELB_IP>.nip.io     → AI Frontend
http://emr.medseal.<ELB_IP>.nip.io     → OpenEMR
http://fhir.medseal.<ELB_IP>.nip.io    → Medplum API
http://medplum.medseal.<ELB_IP>.nip.io → Medplum App
http://api.medseal.<ELB_IP>.nip.io     → AI Service API
```

### Step 7: Update Domain References
After getting the ELB IP, update these files with the new nip.io base:
```bash
# Replace old GCP IP with new Huawei ELB IP
grep -rl "34.54.226.15" k8s/ | xargs sed -i '' "s/34.54.226.15/YOUR_ELB_IP/g"
kubectl apply -f k8s/ -n medseal
```

## Connecting the Patient Portal Native App

Edit `apps/patient-portal-native/lib/api.ts` and update:
```ts
const FHIR_BASE = 'http://fhir.medseal.<ELB_IP>.nip.io';
const AI_BASE   = 'http://api.medseal.<ELB_IP>.nip.io';
```

## Verification

```bash
kubectl get pods -n medseal                           # All Running
kubectl get ingress -n medseal                        # ELB IP assigned
curl http://api.medseal.<ELB_IP>.nip.io/health        # AI service
curl http://fhir.medseal.<ELB_IP>.nip.io/healthcheck  # Medplum
```

## Tear Down

```bash
kubectl delete -f k8s/ -n medseal
# Then delete resources via Huawei Cloud Console or hcloud CLI
```
