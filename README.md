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
sudo apt install -y nginx git
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
3. On first run: installs certbot, obtains a Let's Encrypt TLS certificate via the webroot method, and sets up auto-renewal.
4. Installs the Nginx site config from `nginx/phillipstech.conf`, disables the default Nginx welcome page, and validates the config.
5. Reloads Nginx to apply all changes.

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
