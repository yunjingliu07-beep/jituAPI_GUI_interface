#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
cd /opt/image-meow
[[ -s /var/lib/image-meow/migration-receipt.json ]] || { echo 'Import and verify the old website data before switching domains.' >&2; exit 1; }
node --input-type=module - <<'NODE'
import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync('/var/lib/image-meow/migration-receipt.json','utf8'));
if(r.projectId!=='appgprj_6ad3602eac1c8191beccd3a66e796b09'||!r.counts?.users)process.exit(1);
NODE
[[ -s /etc/letsencrypt/live/imagemeow.top/fullchain.pem && -s /etc/letsencrypt/live/imagemeow.top/privkey.pem ]] || { echo 'Obtain the imagemeow.top certificate first.' >&2; exit 1; }
openssl x509 -in /etc/letsencrypt/live/imagemeow.top/fullchain.pem -checkend 86400 -noout
backup=$(mktemp -d /var/backups/image-meow-domain-XXXXXXXX)
chmod 0700 "$backup"
cp /etc/image-meow/server.env "$backup/server.env"
cp /etc/nginx/sites-available/image-meow.conf "$backup/nginx.conf"
rollback() {
    cp "$backup/server.env" /etc/image-meow/server.env
    cp "$backup/nginx.conf" /etc/nginx/sites-available/image-meow.conf
    systemctl restart image-meow || true
    nginx -t && systemctl reload nginx || true
}
trap rollback ERR
node --input-type=module - <<'NODE'
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const file='/etc/image-meow/server.env',before=readFileSync(file,'utf8');
if(!/^PUBLIC_ORIGIN=https:\/\/(preview\.)?imagemeow\.top$/m.test(before))throw new Error('Unexpected origin.');
writeFileSync(file+'.cutover',before.replace(/^PUBLIC_ORIGIN=.*$/m,'PUBLIC_ORIGIN=https://imagemeow.top'),{mode:0o600});
renameSync(file+'.cutover',file);
NODE
install -m 0644 deploy/ubuntu/nginx-cutover.conf /etc/nginx/sites-available/image-meow.conf
nginx -t
systemctl restart image-meow
systemctl reload nginx
curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 1 \
    --resolve imagemeow.top:443:127.0.0.1 https://imagemeow.top/healthz
trap - ERR
echo
echo "Root domain ready on this server. Backup: $backup"
echo 'Now point the root domain A record to this server and verify HTTPS in a browser.'
