#!/usr/bin/env bash
# Local rehearsal of ci/github-workflow.yml, step for step, before it ever runs in CI.
#
#   ci/rehearse.sh <app-repo> <base-sha> <head-sha>
#
# Mirrors the workflow on a throwaway copy: the app repo is CLONED into a scratch dir (the
# developer's checkout and its uncommitted changes are never touched), started as its own
# docker compose project on its own port, seeded, baselined at <base>, rebuilt at <head>,
# and checked. The Jev cache persists in .autotester/ci-cache (what actions/cache would keep).
#
# App-specific parts are marked APP: they are what a real app's workflow must provide.
# Defaults are for DVinyl; override with the env vars below.
set -euo pipefail

APP_REPO=$(cd "${1:?app repo}" && pwd)
BASE=${2:?base sha}
HEAD=${3:?head sha}
TOOL=$(cd "$(dirname "$0")/.." && pwd)
PORT=${PORT:-3299}
PROJECT=${PROJECT:-autotester-ci}
CONFIG_SRC=${CONFIG_SRC:-$TOOL/examples/dvinyl-qa.config.json}   # APP: autotester.config.json in the app repo
FIXTURE_SRC=${FIXTURE_SRC:-$TOOL/examples/fixtures/dvinyl-qa.json} # APP: committed fixture
MAP_SRC=${MAP_SRC:-$TOOL/examples/.autotester/mindmap/dvinyl/mindmap.json} # APP: committed, enriched mind-map
CACHE=$TOOL/.autotester/ci-cache
WORK=$(mktemp -d "${TMPDIR:-/tmp}/autotester-ci.XXXXXX")
APP=$WORK/app
STORE_DIR=.autotester/mindmap

compose() { (cd "$APP" && docker compose -p "$PROJECT" -f docker-compose.yml -f "$WORK/ports.yml" "$@"); }
cleanup() {
  compose down -v >/dev/null 2>&1 || true
  mkdir -p "$TOOL/.autotester/runs"
  [ -d "$APP/.autotester/runs" ] && cp -R "$APP/.autotester/runs/." "$TOOL/.autotester/runs/" || true
  rm -rf "$WORK"
}
trap cleanup EXIT
wait_up() { curl -s -o /dev/null --retry 60 --retry-delay 2 --retry-connrefused --retry-all-errors "http://localhost:$PORT/login"; }
step() { echo; echo "=== $*"; }

step "checkout app at base $BASE (a clone; the developer's repo is untouched)"
git clone --quiet --no-hardlinks "$APP_REPO" "$APP"
git -C "$APP" checkout --quiet "$BASE"

# what the app repo would have committed: config, fixture, enriched mind-map
mkdir -p "$APP/$STORE_DIR" "$CACHE"
cp "$MAP_SRC" "$APP/$STORE_DIR/mindmap.json"
cp "$FIXTURE_SRC" "$APP/.autotester/fixture.json"
ln -s "$CACHE" "$APP/.autotester/cache"
node -e '
  const fs = require("fs");
  const [src, out, port] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  c.appRoot = ".";
  c.env.baseUrl = `http://localhost:${port}`;
  c.store = { backend: "committed-file", dir: ".autotester/mindmap" };
  c.qa = { ...c.qa, runsDir: ".autotester/runs", seed: { ...c.qa.seed, file: ".autotester/fixture.json" }, launchArgs: process.platform === "linux" ? ["--no-sandbox"] : [] };
  fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n");
' "$CONFIG_SRC" "$APP/autotester.config.json" "$PORT"

# APP: DVinyl reads .env (not in the repo) and refuses empty or published secrets
cat > "$WORK/env" <<EOF
MONGODB_URL=mongodb://mongodb:27017/dvinyl
PASSJWT=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
PROD=false
VINYL_PORT=3099
BASE_URL=
EOF
cp "$WORK/env" "$APP/.env"
# rehearsal only: its own port and container names, next to any running instance
cat > "$WORK/ports.yml" <<EOF
services:
  dvinyl-app:
    container_name: ${PROJECT}_app
    ports: !override
      - "$PORT:3099"
    volumes: !override
      - uploads:/app/public/uploads
  mongodb:
    container_name: ${PROJECT}_db
    volumes: !override
      - mongo:/data/db
volumes:
  uploads:
  mongo:
EOF

step "start the app at base"
compose up -d --build --quiet-pull 2>&1 | tail -2
wait_up

step "seed the fixture"
(cd "$TOOL" && npm run -s qa:seed -- "$APP/autotester.config.json")

step "record the baseline"
(cd "$TOOL" && npm run -s bootstrap -- "$APP/autotester.config.json" | tail -1)
(cd "$TOOL" && npm run -s qa:baseline -- "$APP/autotester.config.json" | grep -E "logged in|visiting|map assertions|Jev:")

step "rebuild at head $HEAD (the baselined mind-map is kept across the checkout)"
cp -R "$APP/$STORE_DIR" "$WORK/mindmap-baseline"
git -C "$APP" checkout --quiet --force "$HEAD"
rm -rf "${APP:?}/$STORE_DIR" && cp -R "$WORK/mindmap-baseline" "$APP/$STORE_DIR"
cp "$WORK/env" "$APP/.env"
compose up -d --build --quiet-pull 2>&1 | tail -2
wait_up

step "check the change (advisory)"
(cd "$TOOL" && npm run -s qa:check -- "$APP/autotester.config.json" "$BASE..$HEAD") || echo "(qa:check exit $? — advisory, the job would still pass)"
