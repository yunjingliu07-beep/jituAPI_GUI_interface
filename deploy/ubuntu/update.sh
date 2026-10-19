#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" == /opt/image-meow ]] || { echo 'Run this script from /opt/image-meow.' >&2; exit 1; }
[[ -f /var/lib/image-meow/studio.sqlite && -f /etc/image-meow/server.env ]] || { echo 'Existing installation not found.' >&2; exit 1; }
grep -qxF 'DATA_DIR=/var/lib/image-meow' /etc/image-meow/server.env || { echo 'Unexpected data directory; no service was stopped.' >&2; exit 1; }
cd /opt/image-meow
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
domain=$(sed -n 's|^PUBLIC_ORIGIN=https://||p' /etc/image-meow/server.env)
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$domain" == *.* && "$domain" != *..* ]] || { echo 'Unexpected public origin.' >&2; exit 1; }
backup=$(mktemp -d /var/backups/image-meow-update-XXXXXXXX)
chmod 0700 "$backup"
systemctl stop image-meow
trap 'echo "Update did not finish. Backup: $backup. Check image-meow before reopening the site." >&2' ERR
cp -a /var/lib/image-meow "$backup/data"
cp -a /etc/image-meow "$backup/config"
git rev-parse HEAD > "$backup/code-commit"
runuser -u image-meow -- env DATA_DIR=/var/lib/image-meow /usr/bin/node server/migrate.mjs
systemctl start image-meow
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 -H "Host: $domain" http://127.0.0.1:3000/healthz
echo
echo "Updated successfully. Backup: $backup"
