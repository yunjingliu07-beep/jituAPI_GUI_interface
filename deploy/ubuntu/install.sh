#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
domain=${1:-preview.imagemeow.top}
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$domain" == *.* && "$domain" != *..* ]] || { echo 'Invalid domain.' >&2; exit 1; }
[[ "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" == /opt/image-meow ]] || { echo 'Clone this repository into /opt/image-meow first.' >&2; exit 1; }
[[ -x /usr/bin/node ]] || { echo 'Install Node.js 24 first.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
command -v nginx >/dev/null
command -v runuser >/dev/null
if ! id image-meow >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/image-meow --shell /usr/sbin/nologin image-meow
fi
install -d -m 0750 -o image-meow -g image-meow /var/lib/image-meow
install -d -m 0700 /etc/image-meow
install -d -m 0755 /var/www/image-meow-acme
if [[ ! -e /etc/image-meow/server.env ]]; then
    # Generated locally on the server. Never print or commit this encryption key.
    node --input-type=module - "$domain" <<'NODE'
import {writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
writeFileSync('/etc/image-meow/server.env',`PUBLIC_ORIGIN=https://${process.argv[2]}\nPORT=3000\nDATA_DIR=/var/lib/image-meow\nAPI_VAULT_KEY=${randomBytes(32).toString('hex')}\n`,{mode:0o600,flag:'wx'});
NODE
else
    grep -qxF "PUBLIC_ORIGIN=https://$domain" /etc/image-meow/server.env || { echo 'Existing configuration uses a different domain; no configuration was overwritten.' >&2; exit 1; }
fi
cd /opt/image-meow
# Migrate while the service is stopped. The EXIT trap restores an existing service if migration fails.
was_active=false
if systemctl is-active --quiet image-meow; then
    was_active=true
    systemctl stop image-meow
fi
trap 'if $was_active; then systemctl start image-meow; fi' EXIT
runuser -u image-meow -- env DATA_DIR=/var/lib/image-meow /usr/bin/node server/migrate.mjs
install -m 0644 deploy/ubuntu/image-meow.service /etc/systemd/system/image-meow.service
systemctl daemon-reload
systemctl enable --now image-meow
was_active=false
trap - EXIT
# Keep an existing TLS configuration on repeat installs.
if [[ ! -e /etc/nginx/sites-available/image-meow.conf ]]; then
    sed "s/__DOMAIN__/$domain/g" deploy/ubuntu/nginx-http.conf > /etc/nginx/sites-available/image-meow.conf
fi
ln -sfn /etc/nginx/sites-available/image-meow.conf /etc/nginx/sites-enabled/image-meow.conf
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 -H "Host: $domain" http://127.0.0.1:3000/healthz
echo
echo 'Backend ready. Next: configure preview DNS and HTTPS; keep the main website unchanged until data migration is complete.'
