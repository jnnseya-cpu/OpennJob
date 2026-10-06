#!/usr/bin/env bash
# One-command install of OpennJob on a fresh Hostinger KVM VPS (Ubuntu 24.04), as root:
#
#   curl -fsSL https://raw.githubusercontent.com/jnnseya-cpu/OpennJob/claude/busy-fermat-9hhn11/deploy/install-hostinger.sh -o install.sh
#   bash install.sh
#
# It asks for the domain, the e-mail for HTTPS certificates and the invited address(es); then
# installs Docker and a firewall, clones the code, generates the secrets, starts the stack
# (docker-compose.prod.yml) and waits for https://DOMAIN/api/health.
#
# Written and syntax-checked, NOT run on a real server. Read each step's output.
# It does not change SSH settings: do that yourself (deploy/hostinger-vps.md, step 2) once you
# have logged in with a key, so you cannot be locked out.
set -euo pipefail

BRANCH="${OPENNJOB_BRANCH:-claude/busy-fermat-9hhn11}"
REPO="${OPENNJOB_REPO:-https://github.com/jnnseya-cpu/OpennJob.git}"
DIR="${OPENNJOB_DIR:-/opt/opennjob}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash install.sh)."; exit 1; }

# ask "question" [default]: Enter keeps the default; an empty answer with no default asks again.
# Messages go to stderr: stdout is the answer.
ask() {
  local prompt="$1" def="${2:-}" var=""
  while [ -z "$var" ]; do
    if [ -n "$def" ]; then read -r -p "$prompt [$def]: " var </dev/tty; var="${var:-$def}"; else read -r -p "$prompt: " var </dev/tty; fi
    [ -n "$var" ] || echo "  A value is needed." >&2
  done
  printf '%s' "$var"
}
DOMAIN="${DOMAIN:-$(ask 'Domain for the app (its DNS A record must point here)' 'opennjob.com')}"
SUPPORT_EMAIL="${SUPPORT_EMAIL:-$(ask 'Support inbox: certificate notices, operator alerts, sender of e-mails' 'support@opennjob.com')}"
ACME_EMAIL="${ACME_EMAIL:-$SUPPORT_EMAIL}"
ALLOWLIST="${OPENNJOB_REGISTRATION_ALLOWLIST:-$(ask 'Invited e-mail address(es), comma separated: the address(es) you will register with')}"
case "$ALLOWLIST" in *@*) ;; *) echo "That does not look like an e-mail address: $ALLOWLIST" >&2; exit 1 ;; esac

# This server may already run other sites. Nothing below may break them.
echo "== Checking what already runs on this server"
BUSY="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
if [ -n "$BUSY" ] && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^opennjob-web'; then
  echo "STOP: ports 80/443 are already in use on this server:" >&2
  echo "$BUSY" >&2
  echo "OpennJob's web server needs them, and taking them would take down whatever serves them now." >&2
  echo "Nothing was changed. Send this output to whoever set up OpennJob: it must be put behind the existing web server instead." >&2
  exit 1
fi
if ufw status 2>/dev/null | grep -q "Status: active"; then UFW_ACTIVE=1; else UFW_ACTIVE=0; fi

echo "== Checking DNS for $DOMAIN"
apt-get update -qq && apt-get install -y -qq curl git ufw dnsutils openssl unattended-upgrades >/dev/null
SERVER_IP="$(curl -fsS4 https://api.ipify.org || true)"
DNS_IP="$(dig +short A "$DOMAIN" | tail -1)"
if [ -z "$DNS_IP" ] || [ "$DNS_IP" != "$SERVER_IP" ]; then
  echo "WARNING: $DOMAIN resolves to '${DNS_IP:-nothing}', this server is '${SERVER_IP:-unknown}'."
  echo "HTTPS certificates will fail until the A record points here. Continue anyway? [y/N]"
  read -r ok </dev/tty; [ "$ok" = "y" ] || exit 1
fi

echo "== Firewall"
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
if [ "$UFW_ACTIVE" = 1 ]; then
  echo "   ufw was already on: HTTP and HTTPS added, existing rules kept."
else
  echo "   ufw is off. Turning it on would block every port except SSH, HTTP and HTTPS. Listening now:"
  ss -Htlnp | awk '{print "     " $4 "  " $6}'
  echo "   Turn the firewall on? Other services on other ports would become unreachable from outside. [y/N]"
  read -r fw </dev/tty
  if [ "$fw" = "y" ]; then ufw --force enable >/dev/null; echo "   ufw on."; else echo "   Left off (rules added for later)."; fi
fi

if ! command -v docker >/dev/null; then
  echo "== Installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version

echo "== Code ($BRANCH) in $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"

ENV_FILE=.env.production
if [ -f "$ENV_FILE" ]; then
  echo "== Keeping the existing $ENV_FILE (secrets are never regenerated: a new data key would make every CV unreadable)"
else
  echo "== Generating secrets into $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<ENV
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
POSTGRES_PASSWORD=$(openssl rand -hex 24)
OPENNJOB_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
OPENNJOB_DATA_KEY=$(openssl rand -base64 32 | tr -d '\n')
OPENNJOB_REGISTRATION_ALLOWLIST=$ALLOWLIST
# Until RESEND_API_KEY is set, e-mail is recorded and not sent (deploy/email-dns.md).
RESEND_API_KEY=
OPENNJOB_EMAIL_FROM="OpennJob <$SUPPORT_EMAIL>"
OPENNJOB_BRAND_FOOTER="OpennJob · $SUPPORT_EMAIL"
ANTHROPIC_API_KEY=
OPENNJOB_MODEL=
OPENNJOB_SCHEDULER=true
OPENNJOB_OPERATOR_EMAIL=$SUPPORT_EMAIL
OPENNJOB_RETENTION_DAYS=
ENV
  chmod 600 "$ENV_FILE"
  echo "   Copy OPENNJOB_DATA_KEY somewhere safe and offline NOW. Losing it loses every CV:"
  grep '^OPENNJOB_DATA_KEY=' "$ENV_FILE"
fi

echo "== Building and starting (first build takes several minutes)"
docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d --build
docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" logs migrate | tail -5

echo "== Waiting for https://$DOMAIN/api/health"
for _ in $(seq 1 60); do
  if out="$(curl -fsS "https://$DOMAIN/api/health" 2>/dev/null)"; then echo "$out"; echo "== Up: https://$DOMAIN"; exit 0; fi
  sleep 5
done
echo "Not answering after 5 minutes. Check: docker compose -f docker-compose.prod.yml --env-file $ENV_FILE ps / logs api / logs web"
exit 1
