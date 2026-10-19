#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" == /opt/image-meow ]] || { echo 'Run this script from /opt/image-meow.' >&2; exit 1; }
[[ -f /var/lib/image-meow/studio.sqlite && -f /etc/image-meow/server.env ]] || { echo 'Existing installation not found.' >&2; exit 1; }
grep -qxF 'DATA_DIR=/var/lib/image-meow' /etc/image-meow/server.env || { echo 'Unexpected data directory; no service was stopped.' >&2; exit 1; }
cd /opt/image-meow
[[ -x /usr/bin/node ]] || { echo 'Install Node.js 24 at /usr/bin/node first.' >&2; exit 1; }
/usr/bin/node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo '/usr/bin/node must be Node.js 24 or newer; no service was stopped.' >&2; exit 1; }
command -v runuser >/dev/null
command -v curl >/dev/null
command -v flock >/dev/null
# Keep overlapping manual updates from restarting the service during another backup.
exec 9>/run/lock/image-meow-update.lock
flock -n 9 || { echo 'Another update is running; wait for it to finish.' >&2; exit 1; }
domain=$(sed -n 's|^PUBLIC_ORIGIN=https://||p' /etc/image-meow/server.env)
[[ "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$domain" == *.* && "$domain" != *..* ]] || { echo 'Unexpected public origin.' >&2; exit 1; }
backup=$(mktemp -d /var/backups/image-meow-update-XXXXXXXX)
chmod 0700 "$backup"
was_active=false
if systemctl is-active --quiet image-meow; then was_active=true; fi
stage='stopping the service'
recover_on_exit=true
finish() {
    local status=$?
    trap - EXIT HUP INT TERM
    if (( status != 0 )); then
        echo "Update interrupted while $stage (exit $status). Backup: $backup" >&2
        if $recover_on_exit && $was_active && ! systemctl is-active --quiet image-meow; then
            echo 'Attempting to restart the previously running service...' >&2
            if systemctl start image-meow; then
                echo 'Start command completed; check service status and /healthz.' >&2
            else
                echo 'Service could not be started. Run: sudo journalctl -u image-meow -n 50 --no-pager' >&2
            fi
        fi
    fi
    exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
echo '[1/5] Stopping image-meow; existing requests may take up to 120 seconds to finish.'
systemctl stop image-meow
stage='backing up data and configuration'
echo "[2/5] Backing up data and configuration to $backup; duration depends on stored files."
cp -a /var/lib/image-meow "$backup/data"
cp -a /etc/image-meow "$backup/config"
git rev-parse HEAD > "$backup/code-commit"
stage='applying database migrations'
echo '[3/5] Applying database migrations.'
runuser -u image-meow -- env DATA_DIR=/var/lib/image-meow /usr/bin/node server/migrate.mjs
stage='starting the service'
echo '[4/5] Starting image-meow.'
systemctl start image-meow
stage='checking service health'
echo '[5/5] Checking service health.'
curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --retry 5 --retry-connrefused --retry-delay 1 -H "Host: $domain" http://127.0.0.1:3000/healthz
recover_on_exit=false
echo
echo "Updated successfully. Backup: $backup"
