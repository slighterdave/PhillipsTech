#!/usr/bin/env bash
# deploy.sh – Pull the latest code from GitHub, configure Nginx, and reload it.
#
# ── How to run ────────────────────────────────────────────────────────────────
# This script lives in the repository at /var/www/phillipstech/deploy.sh.
# DO NOT run it directly as ~/deploy.sh; instead use a thin wrapper so that
# every deployment always uses the latest version from the repository:
#
#   # One-time setup – create the wrapper (see README § "Set Up the Deploy Script")
#   cat > ~/deploy.sh << 'EOF'
#   #!/usr/bin/env bash
#   exec /var/www/phillipstech/deploy.sh "$@"
#   EOF
#   chmod +x ~/deploy.sh
#
# After that, just run ~/deploy.sh as usual.  The wrapper never needs to be
# updated – it always delegates to this file which is refreshed by git pull.
# ──────────────────────────────────────────────────────────────────────────────

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
SSL_DOMAIN="phillipstech.info"
SSL_CERT="/etc/letsencrypt/live/${SSL_DOMAIN}/fullchain.pem"
CERTBOT_EMAIL="${CERT_EMAIL:-admin@${SSL_DOMAIN}}"
BACKEND_DIR="$REPO_DIR/backend"
BACKEND_SERVICE="phillipstech-backend"
BACKEND_SERVICE_FILE="/etc/systemd/system/${BACKEND_SERVICE}.service"
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
  echo "Already up to date ($(git rev-parse --short HEAD))."
else
  echo "Updating $PREV_COMMIT → $NEW_COMMIT"

  # Reset to remote state (discard any local modifications)
  git reset --hard "$GIT_REMOTE/$BRANCH"
  git clean -fd

  echo "Repository updated to $(git rev-parse --short HEAD)."

  # Re-exec the updated script from the top so that the rest of the deployment
  # always runs with the latest code.  Without this, bash continues reading from
  # its old byte offset into the newly-written file and silently skips any
  # sections that were inserted or moved by the update (e.g. backend npm install).
  # On the second run PREV_COMMIT == NEW_COMMIT (the reset already advanced HEAD),
  # so this branch is not taken again – no infinite loop.
  exec "$REPO_DIR/deploy.sh" "$@"
fi

# Fix file ownership so Nginx can serve the files
sudo chown -R "$DEPLOY_USER":"$WEB_USER" "$REPO_DIR"
sudo chmod -R 755 "$REPO_DIR"

# ── Node.js Backend ───────────────────────────────────────────────────────────
# Run this before the Nginx/SSL steps so that backend dependencies are always
# installed even if Nginx configuration or certificate issuance fails.

# Install Node.js (LTS) and npm if not present.
# Check for both: node can exist without npm (e.g. when installed from the
# default Ubuntu apt repo which ships them as separate packages).
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm not found – installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Ensure build tools are present for native Node.js modules (e.g. better-sqlite3)
if ! dpkg -s build-essential >/dev/null 2>&1 || ! dpkg -s python3-minimal >/dev/null 2>&1; then
  echo "Installing build tools for native Node.js modules..."
  sudo apt-get install -y --no-install-recommends build-essential python3-minimal
fi

# Install backend npm dependencies
echo "Installing backend dependencies..."
cd "$BACKEND_DIR"
# Temporarily disable pipefail so that grep -v exiting 1 (when all npm output is
# advisory warnings) does not abort the script.  We check npm's own exit code via
# PIPESTATUS and fail loudly if npm itself reported an error.
set +o pipefail
npm install --omit=dev --no-audit --no-fund 2>&1 | grep -v "^npm warn"
_npm_ec="${PIPESTATUS[0]}"
set -o pipefail
if [ "$_npm_ec" -ne 0 ]; then
  echo "ERROR: npm install failed (exit code $_npm_ec)." >&2
  echo "       Re-running with full output for diagnosis:" >&2
  npm install --omit=dev 2>&1
  exit 1
fi

# Create the .env file if it does not yet exist
if [ ! -f "$BACKEND_DIR/.env" ]; then
  echo "Creating backend/.env from .env.example – please update JWT_SECRET before starting the service."
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  # Generate a random JWT_SECRET automatically
  GENERATED_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${GENERATED_SECRET}|" "$BACKEND_DIR/.env"
  echo "A random JWT_SECRET has been generated in $BACKEND_DIR/.env."
fi

# Set permissions on .env so only the deploy user can read it
chmod 600 "$BACKEND_DIR/.env"
chown "$DEPLOY_USER" "$BACKEND_DIR/.env"

# Install the systemd service unit if it does not already exist
if [ ! -f "$BACKEND_SERVICE_FILE" ]; then
  echo "Installing systemd service unit $BACKEND_SERVICE..."
  sudo tee "$BACKEND_SERVICE_FILE" > /dev/null <<SERVICE
[Unit]
Description=PhillipsTech Node.js Backend
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${BACKEND_DIR}/.env
ExecStart=$(command -v node) ${BACKEND_DIR}/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE
  sudo systemctl daemon-reload
fi

# Enable and (re)start the backend
echo "Starting/Restarting backend service..."
sudo systemctl enable "$BACKEND_SERVICE" || echo "WARNING: Could not enable $BACKEND_SERVICE." >&2
sudo systemctl restart "$BACKEND_SERVICE" || {
  echo "ERROR: Backend service failed to start. Check: sudo journalctl -u $BACKEND_SERVICE --no-pager -n 30" >&2
  exit 1
}
echo "Backend service running (port 3000)."

cd "$REPO_DIR"

# ── SSL Certificate Management ────────────────────────────────────────────────
#
# The SSL config in nginx/phillipstech.conf requires Let's Encrypt certificates.
# This section ensures certs are present and up-to-date before we test/reload
# Nginx.  Two scenarios are handled:
#
#   1. Certs already exist  → run "certbot renew" (no-op if not due yet).
#   2. Certs are missing    → serve a temporary HTTP-only config so the ACME
#                             HTTP-01 challenge can complete, then obtain certs
#                             via certbot.  The full SSL config is installed
#                             after the certs are in place.

# Install certbot if it is not already present (Ubuntu/Debian only – matches the
# rest of this script which also uses apt-get for Node.js and build tools)
if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot not found - installing..."
  sudo apt-get install -y --no-install-recommends certbot
fi

if [ -f "$SSL_CERT" ]; then
  echo "Renewing SSL certificate if due..."
  sudo certbot renew --quiet 2>/dev/null || \
    echo "WARNING: certbot renew encountered an issue (the certificate may still be valid)." >&2
elif command -v certbot >/dev/null 2>&1; then
  echo "No SSL certificate found at $SSL_CERT. Attempting initial issuance..."

  # Stand up a minimal HTTP-only config so the ACME challenge path is reachable.
  # Remove the SSL site symlink first so that nginx -t doesn't fail trying to
  # load the (not-yet-obtained) SSL certificates.
  sudo rm -f "$NGINX_ENABLED"
  sudo tee /etc/nginx/sites-available/phillipstech-acme > /dev/null <<ACME_CONF
server {
    listen 80;
    server_name ${SSL_DOMAIN} www.${SSL_DOMAIN};
    root ${REPO_DIR};
    location / { try_files \$uri \$uri/ =404; }
}
ACME_CONF
  sudo ln -sf /etc/nginx/sites-available/phillipstech-acme \
              /etc/nginx/sites-enabled/phillipstech-acme
  sudo nginx -t && sudo systemctl reload-or-restart nginx || \
    echo "WARNING: Could not start nginx for the ACME challenge; certbot will attempt issuance anyway." >&2

  sudo certbot certonly --webroot -w "$REPO_DIR" \
    -d "$SSL_DOMAIN" -d "www.${SSL_DOMAIN}" \
    --non-interactive --agree-tos -m "$CERTBOT_EMAIL" || \
    echo "WARNING: certbot exited with an error. The site will run on HTTP until the cert is available." >&2

  # certbot certonly exits 0 even when it skips renewal ("Certificate not yet
  # due for renewal; no action taken").  If the cert files are still absent
  # after that run (e.g. the live/ directory was deleted while certbot's renewal
  # config still exists), force-renew to regenerate them.
  if [ ! -f "$SSL_CERT" ]; then
    echo "Cert file still missing after certbot run -- forcing renewal to regenerate cert files..."
    sudo certbot certonly --webroot -w "$REPO_DIR" \
      -d "$SSL_DOMAIN" -d "www.${SSL_DOMAIN}" \
      --non-interactive --agree-tos -m "$CERTBOT_EMAIL" \
      --force-renew && \
      echo "SSL certificate force-renewed and cert files regenerated." || \
      echo "WARNING: Force renewal failed. The site will continue on HTTP." >&2
  fi

  # Remove the temporary ACME config
  sudo rm -f /etc/nginx/sites-enabled/phillipstech-acme \
             /etc/nginx/sites-available/phillipstech-acme
fi

# Helper: returns 0 if the cert file exists AND contains a valid, non-expired certificate.
cert_is_valid() {
  [ -f "$1" ] && openssl x509 -checkend 0 -noout -in "$1" 2>/dev/null
}

# If certs are still missing or invalid after the steps above, fall back to
# HTTP-only so that Nginx can at least start/reload without error.
if ! cert_is_valid "$SSL_CERT"; then
  if [ -f "$SSL_CERT" ]; then
    echo "WARNING: SSL certificate at $SSL_CERT is present but invalid or expired." \
         "Falling back to HTTP-only config." >&2
  else
    echo "SSL certificate unavailable – deploying HTTP-only config as a fallback."
  fi
  NGINX_CONF_SRC="$REPO_DIR/nginx/phillipstech-http.conf"
  # Generate the fallback config on the fly if it doesn't exist in the repo
  if [ ! -f "$NGINX_CONF_SRC" ]; then
    NGINX_CONF_SRC="/tmp/phillipstech-http-fallback.conf"
    cat > "$NGINX_CONF_SRC" <<HTTP_CONF
server {
    listen 80;
    server_name ${SSL_DOMAIN} www.${SSL_DOMAIN};
    root ${REPO_DIR};
    index index.html index.htm;
    location / { try_files \$uri \$uri/ =404; }
}
HTTP_CONF
  fi
fi

# ── Nginx configuration ────────────────────────────────────────────────────────

# Install the site config from the repository
echo "Installing Nginx site configuration..."
sudo cp "$NGINX_CONF_SRC" "$NGINX_AVAILABLE"

# Ensure the phillipstech site is enabled and points to the config just installed
# (ln -sf replaces any stale or differently-targeted symlink)
sudo ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"
echo "Enabled phillipstech site."

# Disable the default Nginx welcome page if it is still enabled
if [ -L "$NGINX_DEFAULT_ENABLED" ]; then
  sudo rm "$NGINX_DEFAULT_ENABLED"
  echo "Disabled default Nginx site."
fi

# Validate config; if the SSL config is broken fall back to HTTP-only rather
# than aborting and leaving nginx dead (which makes the site unreachable).
if ! sudo nginx -t 2>/dev/null; then
  if [ "$NGINX_CONF_SRC" != "$REPO_DIR/nginx/phillipstech-http.conf" ]; then
    echo "WARNING: Nginx config test failed (SSL certificate may be corrupt)." \
         "Falling back to HTTP-only configuration." >&2
    NGINX_CONF_SRC="$REPO_DIR/nginx/phillipstech-http.conf"
    sudo cp "$NGINX_CONF_SRC" "$NGINX_AVAILABLE"
    sudo nginx -t || { echo "ERROR: HTTP-only Nginx configuration is also invalid. Aborting." >&2; exit 1; }
  else
    echo "ERROR: Nginx configuration is invalid. Aborting." >&2
    exit 1
  fi
fi

# Ensure Nginx starts automatically after a reboot
sudo systemctl enable nginx || echo "WARNING: Could not enable nginx for auto-start on boot." >&2

# Reload Nginx if running (non-disruptive), or start it if stopped
echo "Starting/Reloading Nginx..."
sudo systemctl reset-failed nginx 2>/dev/null || true
# Reload systemd manager configuration in case the unit file changed on disk.
# This silences the "Run 'systemctl daemon-reload'" warning and ensures that
# a freshly-installed or updated nginx package can be started/reloaded cleanly.
sudo systemctl daemon-reload
sudo systemctl reload-or-restart nginx || {
  echo "ERROR: Nginx failed to reload/restart. Check the log below for details:" >&2
  sudo journalctl -u nginx --no-pager -n 30 >&2
  exit 1
}

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployment complete."
