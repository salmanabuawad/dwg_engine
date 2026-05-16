#!/bin/bash
# Deploy dwg-engine (backend/app/ + Postgres) to dwg.wavelync.com.
# Mirrors the navvix profile but targets a separate domain, port, systemd
# unit, install dir, and database so it cannot collide with the navvix
# production deployment on the same host.
set -e

REMOTE_HOST="185.229.226.37"
REMOTE_USER="root"
SSH_KEY="$HOME/.ssh/id_ed25519"
APP_DIR="/opt/dwg-engine"
DOMAIN="dwg.wavelync.com"
PORT=8021
SERVICE="dwg-engine-backend"
DB_NAME="dwg_engine"
DB_USER="dwg_engine"
DB_PASS="dwg_engine"

ssh_run() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$REMOTE_USER@$REMOTE_HOST" "$@"; }
scp_r()   { scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -r "$1" "$REMOTE_USER@$REMOTE_HOST:$2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=============================="
echo "  dwg-engine deployment"
echo "  layout: backend/app/, Postgres"
echo "  → $DOMAIN  ($REMOTE_HOST:$PORT)"
echo "=============================="

# ── 1. Provision server directories ──────────────────────────────────────
echo ""
echo "[1/7] Provisioning server..."
ssh_run "mkdir -p $APP_DIR/frontend/dist $APP_DIR/frontend-src $APP_DIR/backend"

# ── 2. Postgres install + database/user setup ────────────────────────────
echo ""
echo "[2/7] Postgres setup..."
ssh_run "
  if ! dpkg -s postgresql >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib
  fi
  systemctl enable --now postgresql >/dev/null
  sudo -u postgres psql -tc \"SELECT 1 FROM pg_database WHERE datname='$DB_NAME'\" | grep -q 1 \
    || sudo -u postgres psql -c \"CREATE DATABASE $DB_NAME;\"
  sudo -u postgres psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'\" | grep -q 1 \
    || sudo -u postgres psql -c \"CREATE USER $DB_USER WITH ENCRYPTED PASSWORD '$DB_PASS';\"
  sudo -u postgres psql -c \"GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;\" >/dev/null
  sudo -u postgres psql -d $DB_NAME -c \"GRANT ALL ON SCHEMA public TO $DB_USER;\" >/dev/null
  echo '      ✓ postgresql ready (db=$DB_NAME, user=$DB_USER)'
"

# ── 3. Upload Python code ────────────────────────────────────────────────
echo ""
echo "[3/7] Uploading Python code..."
ssh_run "rm -rf $APP_DIR/backend/app $APP_DIR/backend/requirements.txt $APP_DIR/scripts"
ssh_run "mkdir -p $APP_DIR/backend"
scp_r "backend/app"              "$APP_DIR/backend/"
scp_r "backend/requirements.txt" "$APP_DIR/backend/requirements.txt"
scp_r "scripts"                  "$APP_DIR/"
if [ -d samples ]; then
  ssh_run "rm -rf $APP_DIR/samples && mkdir -p $APP_DIR/samples"
  scp_r "samples/."             "$APP_DIR/samples/"
fi
ssh_run "mkdir -p $APP_DIR/backend/storage"
echo "      ✓ Code uploaded"

# ── 4. Python venv + dependencies ────────────────────────────────────────
echo ""
echo "[4/7] Python venv + deps..."
ssh_run "
  cd $APP_DIR
  if [ ! -d venv ]; then
    python3 -m venv venv
  fi
  venv/bin/pip install --quiet --upgrade pip
  venv/bin/pip install --quiet -r backend/requirements.txt
  echo '      ✓ deps installed'
"

# ── 5. Upload frontend source + build on server ──────────────────────────
echo ""
echo "[5/7] Uploading frontend source + building on server..."
ssh_run "rm -rf $APP_DIR/frontend-src && mkdir -p $APP_DIR/frontend-src"
scp_r "frontend/index.html"        "$APP_DIR/frontend-src/index.html"
scp_r "frontend/package.json"      "$APP_DIR/frontend-src/package.json"
scp_r "frontend/postcss.config.js" "$APP_DIR/frontend-src/postcss.config.js"
scp_r "frontend/tailwind.config.js" "$APP_DIR/frontend-src/tailwind.config.js"
scp_r "frontend/tsconfig.json"     "$APP_DIR/frontend-src/tsconfig.json"
scp_r "frontend/vite.config.ts"    "$APP_DIR/frontend-src/vite.config.ts"
scp_r "frontend/src"               "$APP_DIR/frontend-src/"
ssh_run "
  set -e
  if ! command -v node >/dev/null 2>&1; then
    echo '      installing nodejs 20.x...'
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  fi
  cd $APP_DIR/frontend-src
  npm install --silent --no-audit --no-fund
  npm run build
  rm -rf $APP_DIR/frontend/dist && mkdir -p $APP_DIR/frontend/dist
  cp -R dist/. $APP_DIR/frontend/dist/
  echo '      ✓ frontend built and installed'
"

# ── 6. systemd unit ──────────────────────────────────────────────────────
echo ""
echo "[6/7] Configuring systemd..."
ssh_run "cat > /etc/systemd/system/${SERVICE}.service << 'SVCEOF'
[Unit]
Description=dwg-engine FastAPI Backend (app.main)
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=exec
User=root
Group=root
WorkingDirectory=$APP_DIR/backend
Environment=DATABASE_URL=postgresql+psycopg2://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
Environment=STORAGE_DIR=$APP_DIR/backend/storage
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $PORT --workers 1 --no-access-log
Restart=always
RestartSec=5
StartLimitInterval=60
StartLimitBurst=3

[Install]
WantedBy=multi-user.target
SVCEOF"

# ── 7. nginx + cert ──────────────────────────────────────────────────────
echo ""
echo "[7/7] Configuring nginx + cert..."
ssh_run "cat > /etc/nginx/sites-available/$DOMAIN << 'NGINXEOF'
server {
    listen 80;
    server_name $DOMAIN;

    root  $APP_DIR/frontend/dist;
    index index.html;

    client_max_body_size 500M;

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml image/svg+xml;
    gzip_min_length 1024;

    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;

    location /api/ {
        proxy_pass         http://127.0.0.1:$PORT/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_request_buffering off;
        client_max_body_size 500M;
    }

    location = /index.html {
        add_header Cache-Control \"no-cache, no-store, must-revalidate\";
        add_header Pragma \"no-cache\";
        try_files \$uri /index.html;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location ~* \.(js|css)\$ {
        expires 1y;
        add_header Cache-Control \"public, immutable\";
        access_log off;
    }

    location ~* \.(woff2?|ttf|svg|png|jpg|ico|webp|pdf|dxf)\$ {
        expires 30d;
        add_header Cache-Control \"public\";
        access_log off;
    }
}
NGINXEOF"

ssh_run "ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN"
ssh_run "nginx -t"
ssh_run "systemctl reload nginx"
ssh_run "certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@wavelync.com --redirect 2>&1 | tail -3 || echo '      (certbot skipped — DNS may not be ready yet)'"

ssh_run "systemctl daemon-reload && systemctl enable $SERVICE && systemctl restart $SERVICE"
ssh_run "sleep 3 && systemctl is-active $SERVICE && echo '      ✓ backend running on port $PORT'"

echo ""
echo "=============================="
echo "  Deployment complete!"
echo "  https://$DOMAIN"
echo "=============================="
