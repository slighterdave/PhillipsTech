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
   - **HTTPS** (port 443) – `0.0.0.0/0` *(recommended)*
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

### 5. Configure Nginx

Create a new Nginx server block:

```bash
sudo nano /etc/nginx/sites-available/phillipstech
```

Paste the following configuration (replace `your-domain.com` with your actual domain or IP address):

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    root /var/www/phillipstech;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # Cache static assets
    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;
}
```

Enable the site and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/phillipstech /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

### 6. (Optional) Enable HTTPS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

Follow the on-screen prompts. Certbot will automatically update your Nginx config and set up auto-renewal.

---

### 7. Set Up the Deploy Script

Copy the included `deploy.sh` script to the server and make it executable:

```bash
cp /var/www/phillipstech/deploy.sh ~/deploy.sh
chmod +x ~/deploy.sh
```

Run it any time you want to pull the latest changes from GitHub:

```bash
~/deploy.sh
```

See the [deploy.sh](#deploysh) section below for details.

---

## `deploy.sh`

The `deploy.sh` script automates pulling the latest code and refreshing the site. It:

1. Pulls the latest changes from the `main` branch.
2. Resets any local modifications so the server always matches the repository.
3. Reloads Nginx to apply any configuration changes.

```bash
./deploy.sh
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
