#!/usr/bin/env bash
set -euo pipefail
# Port/retry overrides allow real TLS regression tests without a privileged listener.
port=${MEOW_HTTPS_CHECK_PORT:-443}
retries=${MEOW_HTTPS_CHECK_RETRIES:-8}
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || exit 2
[[ "$retries" =~ ^[0-9]$ ]] || exit 2
# Every attempt checks the certificate and hostname. Bound the wait for new Nginx workers.
exec curl --fail --silent --show-error --noproxy '*' \
    --retry "$retries" --retry-all-errors --retry-delay 1 --retry-max-time 30 \
    --connect-timeout 3 --max-time 10 \
    --resolve "imagemeow.top:$port:127.0.0.1" "https://imagemeow.top:$port/healthz"
