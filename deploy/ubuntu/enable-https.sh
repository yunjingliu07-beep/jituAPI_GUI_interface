#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
domain=${1:-preview.imagemeow.top}
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$domain" == *.* && "$domain" != *..* ]] || { echo 'Invalid domain.' >&2; exit 1; }
grep -qxF "PUBLIC_ORIGIN=https://$domain" /etc/image-meow/server.env || { echo 'Domain does not match the backend configuration.' >&2; exit 1; }
[[ -s /etc/letsencrypt/live/$domain/fullchain.pem && -s /etc/letsencrypt/live/$domain/privkey.pem ]] || { echo 'Obtain the HTTPS certificate with Certbot first.' >&2; exit 1; }
template=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nginx-https.conf
config=/etc/nginx/sites-available/image-meow.conf
backup=$(mktemp)
cp "$config" "$backup"
sed "s/__DOMAIN__/$domain/g" "$template" > "$config"
if ! nginx -t; then
    cp "$backup" "$config"
    rm "$backup"
    exit 1
fi
rm "$backup"
systemctl reload nginx
echo "HTTPS enabled for https://$domain"
