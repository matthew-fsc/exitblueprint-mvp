# Production compute service (docs/archive/10-production-readiness.md, Phase 1).
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
#   PORT (default 8787), FUNCTIONS_ALLOWED_ORIGIN (default *), AI_GATEWAY_API_KEY (AI narrative via Vercel AI Gateway)
#   PLATFORM_SUPERADMIN_IDS  comma-separated Clerk user ids allowed to call the
#                            `seed-methodology` function (load methodology from
#                            inside the system). Unset → that endpoint is 403.
#   SEED_DIR                 override the /seed path (default: ./seed in the image)
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
# Narrative prompt templates. server/narrative.ts reads prompts/<version>.md at
# generation time (the DB prompt-override registry falls back to these bundled
# files), so without them the AI narrative path throws ENOENT and silently
# degrades to the deterministic composer even when the gateway key is set.
COPY prompts ./prompts
# Canonical methodology (rubric, playbooks, valuation rules, data-room template).
# The `seed-methodology` function reads these at runtime to load the DB from
# inside the system, so they must ship in the image alongside the code.
COPY seed ./seed
# Schema migrations (+ the plain-Postgres shim). `seed-methodology` applies any
# pending migrations before seeding (server/migrate.ts), so a schema-changing
# methodology update — a brand-new table like library_tasks — can be brought
# current in-system without running the CLI against production. The shim is only
# used on plain Postgres (auth schema absent); a no-op cost to ship here.
COPY supabase/migrations ./supabase/migrations
COPY db ./db

EXPOSE 8787
CMD ["npm", "run", "serve:functions"]
