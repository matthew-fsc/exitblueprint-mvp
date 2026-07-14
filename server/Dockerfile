# Production compute service (docs/10-production-readiness.md, Phase 1).
# Serves /functions/v1/* including PDF rendering, so the image needs a real
# Chromium — the Playwright base image ships browsers + their OS deps.
#
# Build from the repo root:  docker build -f server/Dockerfile -t exitblueprint-functions .
# Run:  docker run -p 8787:8787 \
#         -e DATABASE_URL=... -e FUNCTIONS_JWT_SECRET=... -e FUNCTIONS_ALLOWED_ORIGIN=https://app.example.com \
#         exitblueprint-functions
#
# Required env:
#   DATABASE_URL           service-role Postgres connection string (bypasses RLS)
#   Token verification — set at least ONE (both is fine mid-rotation):
#     FUNCTIONS_JWT_SECRET   legacy HS256 shared secret (Settings → API → JWT Secret)
#     SUPABASE_URL           https://<ref>.supabase.co — verifies asymmetric
#                            (ES256/RS256) tokens against the project JWKS
# Optional:
#   PORT (default 8787), FUNCTIONS_ALLOWED_ORIGIN (default *), ANTHROPIC_API_KEY (AI narrative)
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

# Install deps against the committed lockfile first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# App code (server + the shared scoring engine it imports).
COPY tsconfig*.json ./
COPY server ./server
COPY shared ./shared

EXPOSE 8787
CMD ["npm", "run", "serve:functions"]
