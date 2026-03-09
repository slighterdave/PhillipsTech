#!/usr/bin/env bash
# deploy.sh – Pull the latest code from GitHub, configure Nginx with HTTPS, and reload it.
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# On first run the script obtains a Let's Encrypt TLS certificate automatically.
# Set CERT_EMAIL to the address Let's Encrypt should use for renewal notices:
#   CERT_EMAIL=admin@phillipstech.info ./deploy.sh
#
# Run from any directory; the script resolves its own path automatically.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
REPO_DIR="/var/www/phillipstech"
BRANCH="main"
GIT_REMOTE="origin"
DEPLOY_USER="ubuntu"
WEB_USER="www-data"
NGINX_CONF_SRC="$REPO_DIR/nginx/phillipstech.conf"
NGINX_AVAILABLE="/etc/nginx/sites-available/phillipstech"
NGINX_ENABLED="/etc/nginx/sites-enabled/phillipstech"
NGINX_DEFAULT_ENABLED="/etc/nginx/sites-enabled/default"
DOMAIN="phillipstech.info"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
CERT_EMAIL="${CERT_EMAIL:-admin@phillipstech.info}"
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

# ── TLS certificate ────────────────────────────────────────────────────────────

if [ ! -d "$CERT_DIR" ]; then
  echo "No TLS certificate found for $DOMAIN. Obtaining one via Let's Encrypt..."

  # Install certbot if not already present
  if ! command -v certbot >/dev/null 2>&1; then
    echo "Installing certbot..."
    sudo apt-get update -qq
    sudo apt-get install -y certbot
  fi

  # Install a temporary HTTP-only config so Nginx can serve the ACME challenge
  sudo bash -c "cat > $NGINX_AVAILABLE" <<'NGINX_TEMP'
server {
    listen 80;
    server_name phillipstech.info www.phillipstech.info;
    root /var/www/phillipstech;
    location /.well-known/acme-challenge/ {}
    location / { return 404; }
}
NGINX_TEMP

  # Enable site and disable default, then reload for ACME challenge
  if [ ! -L "$NGINX_ENABLED" ]; then
    sudo ln -s "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  fi
  if [ -L "$NGINX_DEFAULT_ENABLED" ]; then
    sudo rm "$NGINX_DEFAULT_ENABLED"
    echo "Disabled default Nginx site."
  fi
  sudo nginx -t || { echo "ERROR: Temporary Nginx config is invalid. Aborting." >&2; exit 1; }
  sudo systemctl reset-failed nginx 2>/dev/null || true
  sudo systemctl reload-or-restart nginx

  # Obtain the certificate using webroot (does not modify the nginx config)
  sudo certbot certonly --webroot \
    --webroot-path "$REPO_DIR" \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos -m "$CERT_EMAIL"

  echo "Certificate obtained for $DOMAIN."
fi

# ── Nginx configuration ────────────────────────────────────────────────────────

# Install the full HTTPS site config
echo "Installing Nginx site configuration..."
sudo cp "$NGINX_CONF_SRC" "$NGINX_AVAILABLE"

# Enable the phillipstech site if not already enabled
if [ ! -L "$NGINX_ENABLED" ]; then
  sudo ln -s "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  echo "Enabled phillipstech site."
fi

# Disable the default Nginx welcome page if it is still enabled
if [ -L "$NGINX_DEFAULT_ENABLED" ]; then
  sudo rm "$NGINX_DEFAULT_ENABLED"
  echo "Disabled default Nginx site."
fi

# Validate config before reloading
sudo nginx -t || { echo "ERROR: Nginx configuration is invalid. Aborting." >&2; exit 1; }

# Reload Nginx if running (non-disruptive), or start it if stopped
echo "Reloading Nginx..."
sudo systemctl reset-failed nginx 2>/dev/null || true
sudo systemctl reload-or-restart nginx || {
  echo "ERROR: Nginx failed to reload/restart. Check the log below for details:" >&2
  sudo journalctl -u nginx --no-pager -n 30 >&2
  exit 1
}

# ── Certbot auto-renewal ───────────────────────────────────────────────────────

# Ensure the Certbot renewal cron job (or systemd timer) is active.
# Certbot's package installs a systemd timer on Ubuntu 20.04+; fall back to
# cron on older systems.
if systemctl list-timers --all 2>/dev/null | grep -q certbot; then
  echo "Certbot systemd renewal timer is already active."
elif ! crontab -l 2>/dev/null | grep -q certbot; then
  (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'sudo systemctl reload nginx'") | crontab -
  echo "Added certbot renewal cron job."
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployment complete."
