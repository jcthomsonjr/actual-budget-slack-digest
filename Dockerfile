# Pin to the exact version confirmed working in manual test runs.
# Update this intentionally when upgrading Node — don't let it float.
FROM node:24.16.0-slim

# Create a non-root user to run the app. Running as root inside a
# container is unnecessary and a bad habit for anything long-lived.
RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

# Copy package files first so Docker can cache the npm install layer
# independently of script changes — rebuilds are faster this way.
COPY package*.json ./

# Install production dependencies only. --omit=dev keeps the image lean.
RUN npm install --omit=dev

# Copy scripts after installing deps so code changes don't bust the
# npm cache layer.
COPY scripts/ ./scripts/

# The actual-cache directory is where @actual-app/api stores its local
# copy of the downloaded budget. Needs to be writable by the app user
# and should persist across runs so Actual doesn't re-download the full
# budget file every Sunday — it only needs to sync deltas.
RUN mkdir -p /tmp/actual-cache && chown appuser:appuser /tmp/actual-cache

USER appuser

# scheduler.js is the entrypoint — it uses node-cron to fire
# weekly-digest.js on schedule. weekly-digest.js can still be run
# directly for manual tests (bypasses the scheduler entirely).
CMD ["node", "scripts/scheduler.js"]
