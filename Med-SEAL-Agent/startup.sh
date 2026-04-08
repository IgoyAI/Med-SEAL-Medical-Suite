#!/bin/bash
set -e

echo "=== Med-SEAL startup: installing dependencies ==="
cd /home/site/wwwroot
python3 -m pip install --no-cache-dir -q -r requirements.txt
echo "=== Dependencies installed. Starting uvicorn ==="
python3 -m uvicorn agent.main:app --host 0.0.0.0 --port 8000
