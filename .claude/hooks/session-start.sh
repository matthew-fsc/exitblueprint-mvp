#!/usr/bin/env bash
# SessionStart hook. Returns fast: it persists the (deterministic) local
# DATABASE_URL for every later shell, kicks off the DB bootstrap in the
# background, and prints orientation context for the agent. The heavy work
# (deps + migrate + seed) runs detached in bootstrap-db.sh.
set -euo pipefail
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$ROOT"

# devdb.sh emits a fixed URL (port 55499, db exit_blueprint), so we can export it
# now — before the cluster is even up — and every subsequent Bash tool shell
# inherits it via ~/.bashrc.
ENVFILE="$ROOT/.claude/.session-env"
{
  echo "export DATABASE_URL='postgresql://postgres@127.0.0.1:55499/exit_blueprint'"
  echo "export EB_PARSER='fixture'"
} > "$ENVFILE"

MARK="# >>> exitblueprint session env >>>"
if ! grep -qF "$MARK" "$HOME/.bashrc" 2>/dev/null; then
  {
    echo "$MARK"
    echo "[ -f '$ENVFILE' ] && . '$ENVFILE'"
    echo "# <<< exitblueprint session env <<<"
  } >> "$HOME/.bashrc"
fi

# Background the slow bootstrap so the session starts immediately.
nohup bash "$ROOT/.claude/hooks/bootstrap-db.sh" \
  > "${TMPDIR:-/tmp}/eb-bootstrap.log" 2>&1 &

# Orientation injected into the agent's context. Single-quoted heredoc: the \n
# escapes are emitted literally and parsed as newlines by the JSON reader.
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ExitBlueprint is bootstrapping this session.\n\nENV: DATABASE_URL and EB_PARSER=fixture are exported for new shells (via ~/.bashrc). Deps + local Postgres + migrate + seed run in the BACKGROUND; the DB is ready when /tmp/eb-bootstrap.done exists (log: /tmp/eb-bootstrap.log). If a DB-backed command reports DATABASE_URL unset, run: source .claude/.session-env. To force readiness now (blocks), run /db-up.\n\nORIENT (read before building):\n- CLAUDE.md — non-negotiable architecture rules (wins over every doc).\n- docs/README.md — docs index + 'feature -> where it lives' code map.\n- docs/27-engineering-patterns.md + templates/ — the canonical way (and skeletons) to add a table / server function / pure module / read / page.\n- docs/28-architecture-map.md — the whole system at a glance.\n\nDEFINITION OF DONE (run before pushing, or /dod): npm run build; npm test (scoring fixtures must still match; runs against the seeded dev DB); firm-isolation via bash .claude/hooks/test-rls.sh (NOT bare npm run test:rls — rls-test needs a clean UNSEEDED DB, so the wrapper runs it on a throwaway DB like CI); fresh-DB migrate+seed; npm run eval ONLY if you touched the AI/narrative layer; append one line to docs/06-decisions.md if a decision was made.\n\nPARALLEL WORK: one branch per build-plan slice; union-merge the append-only/high-contention files (docs/06-decisions.md, docs/README.md, docs/28, src/styles.css, nav) — keep BOTH sides, never overwrite."}}
JSON
