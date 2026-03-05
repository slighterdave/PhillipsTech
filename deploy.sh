#!/usr/bin/env bash
# deploy.sh – Pull the latest code from GitHub and reload Nginx.
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Run from any directory; the script resolves its own path automatically.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
REPO_DIR="/var/www/phillipstech"
BRANCH="main"
GIT_REMOTE="origin"
DEPLOY_USER="ubuntu"
WEB_USER="www-data"
# ──────────────────────────────────────────────────────────────────────────────

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TIMESTAMP] Starting deployment..."

# Verify the repo directory exists
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: $REPO_DIR is not a git repository." >&2
  echo "       Clone the repo first: sudo git clone https://github.com/slighterdave/PhillipsTech.git $REPO_DIR" >&2
  exit 1
fi

cd "$REPO_DIR"

# Fetch latest refs
echo "Fetching from $GIT_REMOTE..."
git fetch "$GIT_REMOTE" "$BRANCH"

# Show what changed
PREV_COMMIT=$(git rev-parse HEAD)
NEW_COMMIT=$(git rev-parse "$GIT_REMOTE/$BRANCH")

if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo "Already up to date ($(git rev-parse --short HEAD)). Nothing to deploy."
else
  echo "Updating $PREV_COMMIT → $NEW_COMMIT"

  # Reset to remote state (discard any local modifications)
  git reset --hard "$GIT_REMOTE/$BRANCH"
  git clean -fd

  echo "Repository updated to $(git rev-parse --short HEAD)."
fi

# Fix file ownership so Nginx can serve the files
sudo chown -R "$DEPLOY_USER":"$WEB_USER" "$REPO_DIR"
sudo chmod -R 755 "$REPO_DIR"

# Reload Nginx (non-disruptive – no downtime)
echo "Reloading Nginx..."
sudo systemctl reload nginx

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployment complete."
