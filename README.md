# PhillipsTech

Static marketing website for PhillipsTech – a managed IT services company. Built with plain HTML, CSS, and vanilla JavaScript.

---

## Hosting on AWS (Ubuntu)

Follow these steps to deploy the site on an Ubuntu EC2 instance using Nginx.

### 1. Launch an Ubuntu EC2 Instance

1. Sign in to the [AWS Management Console](https://console.aws.amazon.com/).
2. Navigate to **EC2 → Instances → Launch Instances**.
3. Choose **Ubuntu Server 22.04 LTS (HVM), SSD Volume Type** as the AMI.
4. Select an instance type (e.g. `t3.micro` for low-traffic sites; eligible for the free tier).
5. Under **Key pair**, create or select an existing key pair and download the `.pem` file.
6. Under **Network settings**, create or select a security group with the following inbound rules:
   - **SSH** (port 22) – your IP only
   - **HTTP** (port 80) – `0.0.0.0/0`
   - **HTTPS** (port 443) – `0.0.0.0/0`
7. Accept the default 8 GiB gp3 volume and click **Launch Instance**.
8. Note the instance's **Public IPv4 address** or assign an **Elastic IP** for a stable address.

---

### 2. Connect to the Instance

```bash
chmod 400 /path/to/your-key.pem
ssh -i /path/to/your-key.pem ubuntu@<YOUR_PUBLIC_IP>
```

---

### 3. Update the System and Install Dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl
```

Node.js (LTS) is installed automatically by `deploy.sh` on first run. To install it manually:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

### 4. Clone the Repository

```bash
cd /var/www
sudo git clone https://github.com/slighterdave/PhillipsTech.git phillipstech
sudo chown -R ubuntu:www-data /var/www/phillipstech
sudo chmod -R 755 /var/www/phillipstech
```

---

### 5. Configure Nginx and Obtain a TLS Certificate

The `deploy.sh` script handles all of this automatically on first run (see [Set Up the Deploy Script](#7-set-up-the-deploy-script) below). If you prefer to do it manually:

```bash
# Install the site config
sudo cp /var/www/phillipstech/nginx/phillipstech.conf /etc/nginx/sites-available/phillipstech
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/phillipstech /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

> **Note:** Removing the `default` symlink from `sites-enabled` is important — without it, Nginx serves the built-in "Welcome to nginx!" page for all unrecognized hostnames, including `phillipstech.info`.

---

### 6. Enable HTTPS with Let's Encrypt

The `deploy.sh` script handles certificate issuance automatically on first run. To do it manually:

```bash
sudo apt install -y certbot
sudo certbot certonly --webroot \
  --webroot-path /var/www/phillipstech \
  -d phillipstech.info -d www.phillipstech.info \
  --non-interactive --agree-tos -m admin@phillipstech.info
```

The nginx configuration already references the standard Let's Encrypt certificate paths (`/etc/letsencrypt/live/phillipstech.info/`), so no edits to the config are needed after the certificate is issued.

**Auto-renewal** is managed by certbot's built-in systemd timer (Ubuntu 20.04+). To verify:

```bash
sudo systemctl status certbot.timer
```

---

### 7. Set Up the Deploy Script

Create a **permanent thin wrapper** at `~/deploy.sh` that always delegates to the
copy of `deploy.sh` inside the repository.  Unlike copying the file directly, this
wrapper **never needs to be updated** – every run automatically uses the latest
version that was just pulled from GitHub.

```bash
cat > ~/deploy.sh << 'EOF'
#!/usr/bin/env bash
exec /var/www/phillipstech/deploy.sh "$@"
EOF
chmod +x ~/deploy.sh
```

Run it any time you want to pull the latest changes from GitHub:

```bash
~/deploy.sh
```

> **Why a wrapper instead of a copy?**
> If you copy `deploy.sh` to `~/deploy.sh`, the copy becomes stale the moment the
> repository is updated.  The thin wrapper solves this permanently: `~/deploy.sh`
> will never need to change, and every deployment runs the freshest repo code.

See the [deploy.sh](#deploysh) section below for details.

---

## `deploy.sh`

The `deploy.sh` script automates pulling the latest code and refreshing the site. It:

1. Pulls the latest changes from the `main` branch.
2. Resets any local modifications so the server always matches the repository.
3. Installs Node.js if not present, runs `npm install` in `backend/`, and starts/restarts the `phillipstech-backend` systemd service.
4. On first run: installs certbot, obtains a Let's Encrypt TLS certificate via the webroot method, and sets up auto-renewal.
5. Installs the Nginx site config from `nginx/phillipstech.conf`, disables the default Nginx welcome page, and validates the config.
6. Reloads Nginx to apply all changes.

By default the script uses `admin@phillipstech.info` as the Let's Encrypt registration address. Override it with the `CERT_EMAIL` environment variable:

```bash
CERT_EMAIL=you@example.com ~/deploy.sh
```

> **Tip:** To deploy automatically on a schedule, add it to cron:
>
> ```bash
> crontab -e
> # Pull & deploy every day at 2 AM
> 0 2 * * * /home/ubuntu/deploy.sh >> /home/ubuntu/deploy.log 2>&1
> ```

---

## Backend & Admin Portal

The site includes a Node.js/Express backend that powers:

- **Contact form** – submissions from the main site are stored in a local SQLite database.
- **Admin portal** – accessible at `/admin/login.html`, protected by JWT authentication.

### Architecture

```
Nginx (443/80)
├── /api/*       → proxy → Node.js backend (127.0.0.1:3000)
├── /admin/*     → proxy → Node.js backend (static admin pages)
└── /*           → static files in /var/www/phillipstech
```

The backend runs as a systemd service (`phillipstech-backend`) managed automatically by `deploy.sh`.

### First-time setup (after `deploy.sh`)

1. **Create the admin account:**

   ```bash
   cd /var/www/phillipstech/backend
   node seed.js admin@example.com 'YourSecurePassword!'
   ```

2. **Visit the admin portal:** `https://phillipstech.info/admin/login.html`

### Updating environment variables

The backend reads its configuration from `backend/.env` (auto-created by `deploy.sh` with a generated `JWT_SECRET`). To change settings:

```bash
nano /var/www/phillipstech/backend/.env
sudo systemctl restart phillipstech-backend
```

See `backend/.env.example` for all available options.

### Local development (frontend + backend together)

**Prerequisites:** Node.js ≥ 18 must be installed.

- **Ubuntu/Debian:**
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **macOS:** `brew install node`
- **Windows / other:** download the installer from [nodejs.org](https://nodejs.org/)

All commands below are run from the **repository root** (`/var/www/phillipstech` on a server, or wherever you cloned the repo locally).

```bash
# Terminal 1 – backend (run from the repo root)
cd backend
cp .env.example .env

# Generate a random JWT_SECRET and write it into .env automatically
node -e "
  const fs = require('fs');
  const secret = require('crypto').randomBytes(64).toString('hex');
  let env = fs.readFileSync('.env', 'utf8');
  fs.writeFileSync('.env', env.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + secret));
  console.log('JWT_SECRET generated and written to .env');
"

npm install
node seed.js admin@example.com Password123!
node server.js                # listens on http://127.0.0.1:3000

# Terminal 2 – frontend static files (served by backend at /admin/* and /api/*)
# Open http://localhost:3000/admin/login.html in a browser
# For the main site, use a static server pointing at the repo root:
python3 -m http.server 8080
```

---

## Local Development

No build step is required. Open `index.html` directly in a browser or use any static file server, e.g.:

```bash
# Python 3
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

---

## Troubleshooting

### `nginx.service is not active, cannot reload`

This error means your `~/deploy.sh` is an **old copy** of the script that runs
`systemctl reload nginx` directly.  Because the service is stopped (or was never
started), reload fails.

**One-time fix – replace `~/deploy.sh` with the thin wrapper:**

```bash
cat > ~/deploy.sh << 'EOF'
#!/usr/bin/env bash
exec /var/www/phillipstech/deploy.sh "$@"
EOF
chmod +x ~/deploy.sh
~/deploy.sh
```

The wrapper calls `/var/www/phillipstech/deploy.sh` which handles all edge cases:
it runs `systemctl daemon-reload` first (clears the "unit file changed" warning),
then `systemctl reload-or-restart nginx` (starts nginx if stopped, reloads if
running), and installs a valid HTTP-only config automatically when SSL certificates
are not yet available.

After the one-time fix above, you never need to update `~/deploy.sh` again.
