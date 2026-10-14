#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu server (Oracle Cloud Always Free, Hetzner, any VPS).
# Usage:  bash setup-server.sh <git clone URL> <domain>
#   e.g.  bash setup-server.sh https://<token>@github.com/you/producttryon.git 141-148-12-34.sslip.io
set -euo pipefail
REPO="${1:?git clone URL}"
DOMAIN="${2:?domain, e.g. tryon.yourbrand.com or <ip-with-dashes>.sslip.io}"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Oracle's Ubuntu images block ports 80/443 in iptables even after the cloud
# firewall (security list) allows them.
if command -v netfilter-persistent >/dev/null; then
  for port in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
      sudo iptables -I INPUT 5 -p tcp --dport "$port" -j ACCEPT
  done
  sudo netfilter-persistent save
fi

[ -d producttryon ] || git clone --depth 1 --branch main "$REPO" producttryon
cd producttryon
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^PLATFORM_ADMIN_KEY=.*|PLATFORM_ADMIN_KEY=$(openssl rand -hex 24)|" .env
  echo "Created .env. Add INVITE_CODES (and GEMINI_API_KEY if you have one) with: nano producttryon/.env"
fi

sudo docker compose up -d --build
echo
echo "Live at https://$DOMAIN/s/demo  (the certificate can take a minute on first start)"
echo "Demo studio token: sudo docker compose logs app | grep 'Admin token'"
