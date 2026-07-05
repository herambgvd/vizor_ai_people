# People Analytics backend image (standalone repo). Build context = the repo root (so it can
# COPY the vendored platform + the backend source).
#   docker build -f backend/Dockerfile -t vizor-people-analytics-backend .
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl \
 && rm -rf /var/lib/apt/lists/*

# Install the vendored edge boilerplate (extras: messaging/tasks/reports/system/
# storage/runtime/vector — trim in this file if a scenario doesn't need CV/vector).
COPY platform /edge
RUN pip install --no-cache-dir -e "/edge[messaging,tasks,reports,system,storage,runtime,vector]"

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY backend/alembic.ini ./
RUN pip install --no-cache-dir -e "."

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
