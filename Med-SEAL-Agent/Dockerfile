FROM python:3.11-slim

WORKDIR /app

# Install basic system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# We need both the main requirements (for general tools) and the agent requirements
COPY requirements.txt agent/requirements_agent.txt ./

# Install python packages
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir -r requirements_agent.txt

# Copy the agent application code
COPY agent /app/agent

# Set the python path so modules resolve correctly
ENV PYTHONPATH=/app

# Expose port for FastAPI
EXPOSE 8000

# Start Uvicorn
CMD ["uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "120"]
