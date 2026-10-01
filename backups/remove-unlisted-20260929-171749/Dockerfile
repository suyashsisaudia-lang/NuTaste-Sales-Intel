# Single container, all configuration via environment variables, so the same
# image runs on Azure App Service, Render, Railway, Fly.io or a local server.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY config ./config

# Seed datasets are copied to an image location; on first boot they are copied
# into DATA_DIR only if it is empty, so a mounted volume is never overwritten.
COPY data ./seed
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh && mkdir -p /data

# Hosts that inject PORT (Render, Railway, Fly, App Service) override this.
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",8000)}/healthz').read()" || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
