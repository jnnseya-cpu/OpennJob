#!/usr/bin/env bash
# Install or update OpennJob on a Hostinger VPS (Ubuntu 22.04/24.04), as root:
#
#   cd /root && curl -fsSL https://raw.githubusercontent.com/jnnseya-cpu/OpennJob/claude/busy-fermat-9hhn11/deploy/install-hostinger.sh -o install.sh && bash install.sh
#
# Paste it as ONE line: the questions read the keyboard, so further pasted lines become answers.
#
# Two ways to run, chosen from what the server already does:
#
#   * ports 80/443 free: OpennJob's own Caddy takes them and gets the HTTPS certificate.
#   * ports 80/443 taken (the server already hosts other sites): OpennJob listens on a local port
#     only (127.0.0.1:8090 by default), and the existing web server forwards the domain to it.
#     For nginx and Apache the script can add that site itself: it asks first, tests the
#     configuration, reloads only if the test passes, and removes its file if it fails. Other
#     web servers get the exact lines to add. Other sites are not touched.
#
# It never changes SSH settings and never turns a firewall on without asking.
# Written and tested in parts (syntax, prompts, compose files, Caddyfile); not run end to end on a
# real server. Read each step's output.
set -euo pipefail

BRANCH="${OPENNJOB_BRANCH:-claude/busy-fermat-9hhn11}"
REPO="${OPENNJOB_REPO:-https://github.com/jnnseya-cpu/OpennJob.git}"
DIR="${OPENNJOB_DIR:-/opt/opennjob}"
ENV_FILE=.env.production

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
[ "$(id -u)" -eq 0 ] || { warn "Run as root (sudo bash install.sh)."; exit 1; }

# ask "question" [default]: Enter keeps the default; an empty answer with no default asks again.
ask() {
  local prompt="$1" def="${2:-}" var=""
  while [ -z "$var" ]; do
    if [ -n "$def" ]; then read -r -p "$prompt [$def]: " var </dev/tty; var="${var:-$def}"; else read -r -p "$prompt: " var </dev/tty; fi
    [ -n "$var" ] || warn "  A value is needed."
  done
  printf '%s' "$var"
}
yes_no() { local a; read -r -p "$1 [y/N]: " a </dev/tty; [ "$a" = "y" ] || [ "$a" = "Y" ]; }

existing_env() { [ -f "$DIR/$ENV_FILE" ] && grep -E "^$1=" "$DIR/$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true; }

DOMAIN="${DOMAIN:-$(ask 'Domain for the app (its DNS A record must point here)' "$(existing_env DOMAIN | grep . || echo opennjob.com)")}"
SUPPORT_EMAIL="${SUPPORT_EMAIL:-$(ask 'Support inbox: certificate notices, operator alerts, sender of e-mails' "$(existing_env ACME_EMAIL | grep . || echo support@opennjob.com)")}"
ALLOWLIST="${OPENNJOB_REGISTRATION_ALLOWLIST:-$(ask 'Invited e-mail address(es), comma separated: the address(es) you will register with' "$(existing_env OPENNJOB_REGISTRATION_ALLOWLIST)")}"
is_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }
is_domain() { [[ "$1" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]] && ! [[ "$1" =~ ^[0-9.]+$ ]]; }
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
is_domain "$DOMAIN" || { warn "'$DOMAIN' is not a domain name (an IP address will not get an HTTPS certificate). Run again and press Enter for opennjob.com."; exit 1; }
is_email "$SUPPORT_EMAIL" || { warn "'$SUPPORT_EMAIL' is not an e-mail address. Run again and press Enter for support@opennjob.com."; exit 1; }
IFS=',' read -r -a _invited <<<"$ALLOWLIST"
for a in "${_invited[@]}"; do a="${a// /}"; is_email "$a" || { warn "'$a' is not an e-mail address."; exit 1; }; done

say "== Packages"
apt-get update -qq && apt-get install -y -qq curl git dnsutils openssl iproute2 >/dev/null

say "== DNS for $DOMAIN"
SERVER_IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
DNS_IP="$(dig +short A "$DOMAIN" | tail -1)"
if [ -z "$DNS_IP" ] || [ "$DNS_IP" != "$SERVER_IP" ]; then
  warn "WARNING: $DOMAIN resolves to '${DNS_IP:-nothing}', this server is '${SERVER_IP:-unknown}'."
  warn "HTTPS will fail until the A record for $DOMAIN points here."
  yes_no "Continue anyway?" || exit 1
else
  say "   $DOMAIN -> $DNS_IP (this server)"
fi

# --- What already serves ports 80/443? ---------------------------------------------------------
OURS="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^opennjob-web' || true)"
HOLDERS="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -oE 'users:\(\("[^"]+' | sed 's/users:(("//' | sort -u | tr '\n' ' ' || true)"
MODE=direct
if [ -n "$(existing_env OPENNJOB_MODE)" ]; then MODE="$(existing_env OPENNJOB_MODE)"
elif [ -n "$HOLDERS" ] && [ -z "$OURS" ]; then MODE=proxy; fi
say "== Mode: $MODE${HOLDERS:+ (ports 80/443 held by: $HOLDERS)}"

PROXY_KIND=other
case " $HOLDERS " in
  *" nginx "*) PROXY_KIND=nginx ;;
  *" apache2 "*|*" httpd "*) PROXY_KIND=apache ;;
  *" caddy "*) PROXY_KIND=caddy ;;
  *" docker-proxy "*) PROXY_KIND=docker ;;
esac

# When a web server in Docker holds port 443 (for example a Caddy container serving the other sites),
# OpennJob joins that container's network and the web server reaches it by name.
EDGE="$(docker ps --filter publish=443 --format '{{.Names}}' 2>/dev/null | head -1 || true)"
EDGE_NET=""; EDGE_IMAGE=""; EDGE_CADDYFILE=""
if [ -n "$EDGE" ] && [ "$EDGE" != "$OURS" ] && [ -z "$OURS" ] || [ -n "$(existing_env EDGE)" ]; then
  EDGE="$(existing_env EDGE | grep . || echo "$EDGE")"
  EDGE_NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$EDGE" | awk '{print $1}')"
  EDGE_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$EDGE")"
  EDGE_CADDYFILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$EDGE")"
  if [ -z "$EDGE_CADDYFILE" ]; then
    EDGE_DIR="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$EDGE")"
    [ -n "$EDGE_DIR" ] && [ -f "$EDGE_DIR/Caddyfile" ] && EDGE_CADDYFILE="$EDGE_DIR/Caddyfile"
  fi
  PROXY_KIND=docker
  say "   Web server in Docker: $EDGE ($EDGE_IMAGE), network $EDGE_NET${EDGE_CADDYFILE:+, Caddyfile $EDGE_CADDYFILE}"
fi

WEB_PORT="$(existing_env WEB_PORT)"
WEB_BIND="$(existing_env WEB_BIND)"
if [ "$MODE" = proxy ] && [ -z "$WEB_PORT" ]; then
  WEB_PORT=8090
  while ss -Htln "( sport = :$WEB_PORT )" | grep -q .; do WEB_PORT=$((WEB_PORT + 1)); done
fi
[ "$MODE" = proxy ] && WEB_BIND="${WEB_BIND:-127.0.0.1}"

# --- Firewall: add rules, never switch it on without asking ------------------------------------
if command -v ufw >/dev/null; then
  if ufw status | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
    say "== Firewall already on: HTTP/HTTPS allowed, other rules kept"
  else
    say "== Firewall (ufw) is off; left as it is"
  fi
fi

# --- Docker -------------------------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  say "== Installing Docker"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
docker compose version

# --- Code ---------------------------------------------------------------------------------------
say "== Code ($BRANCH) in $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q --ff-only origin "$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"

# --- Secrets (generated once, never replaced) ---------------------------------------------------
if [ -f "$ENV_FILE" ]; then
  say "== Keeping the existing $ENV_FILE (a new data key would make every stored CV unreadable)"
else
  say "== Generating secrets into $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<ENV
DOMAIN=$DOMAIN
ACME_EMAIL=$SUPPORT_EMAIL
POSTGRES_PASSWORD=$(openssl rand -hex 24)
OPENNJOB_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
OPENNJOB_DATA_KEY=$(openssl rand -base64 32 | tr -d '\n')
OPENNJOB_REGISTRATION_ALLOWLIST=$ALLOWLIST
# E-mail is recorded and not sent until SMTP is set: bash deploy/set-smtp.sh (asks for the mailbox password).
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASSWORD=
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
  # The key is written to a root-only file, not printed, so it does not end up in a terminal log or a chat.
  KEYFILE=/root/opennjob-data-key.txt
  ( umask 077; grep '^OPENNJOB_DATA_KEY=' "$ENV_FILE" | cut -d= -f2- > "$KEYFILE" )
  warn ""
  warn "   The data encryption key is in $KEYFILE (root only). Copy it somewhere safe and offline,"
  warn "   then delete that file. Losing the key loses every stored CV. Do not paste it anywhere."
  warn ""
fi
# How this server runs OpennJob (kept for updates).
sed -i '/^OPENNJOB_MODE=/d;/^WEB_PORT=/d;/^WEB_BIND=/d;/^EDGE=/d' "$ENV_FILE"
{ echo "OPENNJOB_MODE=$MODE"; if [ "$MODE" = proxy ]; then echo "WEB_PORT=$WEB_PORT"; echo "WEB_BIND=$WEB_BIND"; fi; [ -n "$EDGE_NET" ] && echo "EDGE=$EDGE"; } >> "$ENV_FILE"
rm -f compose.local.yml
if [ -n "$EDGE_NET" ]; then
  # Join the web server's network, reachable there as "opennjob-web". Only the web container joins:
  # the API and the database stay on OpennJob's own network.
  cat > compose.local.yml <<YML
services:
  web:
    networks:
      default: {}
      edge:
        aliases: [opennjob-web]
networks:
  edge:
    external: true
    name: $EDGE_NET
YML
fi

# A short command for later: ./oj ps | ./oj logs api | ./oj up -d --build
FILES="-f docker-compose.prod.yml"
[ "$MODE" = proxy ] && FILES="$FILES -f deploy/docker-compose.behind-proxy.yml"
[ -f compose.local.yml ] && FILES="$FILES -f compose.local.yml"
cat > oj <<OJ
#!/bin/sh
cd "$DIR" && exec docker compose $FILES --env-file $ENV_FILE "\$@"
OJ
chmod 700 oj

say "== Building and starting (the first build takes several minutes)"
./oj up -d --build
./oj logs migrate | tail -3

# --- The existing web server ---------------------------------------------------------------------
UPSTREAM="http://$WEB_BIND:${WEB_PORT:-8090}"
NGINX_SITE="server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 6m;   # CV uploads up to 5 MB
    location / {
        proxy_pass $UPSTREAM;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}"
APACHE_SITE="<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyPass / $UPSTREAM/
    ProxyPassReverse / $UPSTREAM/
    LimitRequestBody 6291456
</VirtualHost>"
CADDY_SITE="$DOMAIN {
    reverse_proxy $UPSTREAM
}"

https_for() { # $1 = nginx | apache
  if ! yes_no "Get the HTTPS certificate for $DOMAIN now with certbot (Let's Encrypt)?"; then return 0; fi
  apt-get install -y -qq certbot "python3-certbot-$1" >/dev/null
  certbot "--$1" -d "$DOMAIN" --non-interactive --agree-tos -m "$SUPPORT_EMAIL" --redirect
}

if [ "$MODE" = proxy ]; then
  say "== OpennJob is listening on $UPSTREAM (this machine only)"
  printf '   waiting for it to answer'
  for _ in $(seq 1 36); do curl -fsS --max-time 5 "$UPSTREAM/api/health" >/dev/null 2>&1 && break; printf '.'; sleep 5; done
  say ""
  if ! curl -fsS --max-time 5 "$UPSTREAM/api/health"; then
    warn "OpennJob does not answer on $UPSTREAM/api/health after 3 minutes. What it shows:"
    curl -sS --max-time 5 -o /dev/null -w '   web answers HTTP %{http_code} on /api/health\n' "$UPSTREAM/api/health" >&2 || true
    ./oj ps >&2 || true
    ./oj logs --tail 25 web api >&2 || true
    warn "Send this output (it holds no passwords or keys) to whoever set up OpennJob."
    exit 1
  fi
  say ""

  case "$PROXY_KIND" in
    nginx)
      CONF=/etc/nginx/sites-available/$DOMAIN; [ -d /etc/nginx/sites-available ] || CONF=/etc/nginx/conf.d/$DOMAIN.conf
      if grep -rqs "server_name[^;]*\b$DOMAIN\b" /etc/nginx/ && [ ! -f "$CONF" ]; then
        warn "nginx already has a site for $DOMAIN. Not changing it. Point it at $UPSTREAM, using these lines as a guide:"; warn "$NGINX_SITE"
      elif yes_no "Add $DOMAIN to nginx ($CONF), forwarding to OpennJob? Other sites are not touched."; then
        printf '%s\n' "$NGINX_SITE" > "$CONF"
        [ -d /etc/nginx/sites-enabled ] && [[ "$CONF" == */sites-available/* ]] && ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"
        if nginx -t; then systemctl reload nginx; say "   nginx reloaded."; https_for nginx
        else warn "nginx rejected the configuration; removing $CONF so your other sites stay as they were."; rm -f "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"; exit 1; fi
      else say "Add this to nginx yourself:"; say "$NGINX_SITE"; fi ;;
    apache)
      CONF=/etc/apache2/sites-available/$DOMAIN.conf
      if yes_no "Add $DOMAIN to Apache ($CONF), forwarding to OpennJob? Other sites are not touched."; then
        a2enmod -q proxy proxy_http headers >/dev/null
        printf '%s\n' "$APACHE_SITE" > "$CONF"; a2ensite -q "$DOMAIN" >/dev/null
        if apachectl configtest; then systemctl reload apache2; say "   Apache reloaded."; https_for apache
        else warn "Apache rejected the configuration; removing it."; a2dissite -q "$DOMAIN" >/dev/null || true; rm -f "$CONF"; exit 1; fi
      else say "Add this to Apache yourself:"; say "$APACHE_SITE"; fi ;;
    caddy)
      say "Your server runs Caddy. Add this to its Caddyfile (usually /etc/caddy/Caddyfile), then: systemctl reload caddy"
      say "$CADDY_SITE" ;;
    docker)
      BLOCK="$DOMAIN {
	request_body {
		max_size 6MB
	}
	reverse_proxy opennjob-web:8080
}"
      if [ -n "$EDGE_CADDYFILE" ] && [[ "$EDGE_IMAGE" == *caddy* ]]; then
        if grep -qE "^[[:space:]]*(https?://)?$DOMAIN([[:space:],:{]|$)" "$EDGE_CADDYFILE"; then
          say "   $EDGE_CADDYFILE already has a site for $DOMAIN; not changing it. It must forward to opennjob-web:8080."
        elif yes_no "Add $DOMAIN to $EDGE_CADDYFILE (backed up first) and reload $EDGE? Other sites are not touched."; then
          BACKUP="$EDGE_CADDYFILE.before-opennjob.$(date +%Y%m%d%H%M%S)"
          cp -p "$EDGE_CADDYFILE" "$BACKUP"
          printf '\n# OpennJob (added by deploy/install-hostinger.sh; backup: %s)\n%s\n' "$BACKUP" "$BLOCK" >> "$EDGE_CADDYFILE"
          if docker exec "$EDGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
             && docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
            say "   $EDGE reloaded. It gets the certificate for $DOMAIN itself."
          else
            warn "Caddy rejected the change; restoring $EDGE_CADDYFILE from the backup. Your other sites are as they were."
            cat "$BACKUP" > "$EDGE_CADDYFILE"   # same file, so the container's bind mount still sees it
            docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
            exit 1
          fi
        else
          say "Add this to $EDGE_CADDYFILE, then: docker exec $EDGE caddy reload --config /etc/caddy/Caddyfile"
          say "$BLOCK"
        fi
      else
        say "Ports 80/443 are held by the container $EDGE ($EDGE_IMAGE). OpennJob has joined its network $EDGE_NET as opennjob-web."
        say "Add a site for $DOMAIN in it that forwards to http://opennjob-web:8080, with HTTPS and uploads up to 6 MB."
      fi ;;
    *)
      say "Ports 80/443 are held by: ${HOLDERS:-unknown}. Add a site (proxy host) for $DOMAIN that forwards to $UPSTREAM"
      say "in that web server or panel, with HTTPS (Let's Encrypt) and uploads up to 6 MB allowed." ;;
  esac
fi

say "== Checking https://$DOMAIN/api/health"
for _ in $(seq 1 24); do
  if out="$(curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null)"; then
    say "$out"; say "== Up: https://$DOMAIN"
    grep -q '^SMTP_PASSWORD=.' "$ENV_FILE" || say "Next: turn on e-mail with   cd $DIR && bash deploy/set-smtp.sh"
    exit 0
  fi
  sleep 5
done
warn "https://$DOMAIN does not answer yet. If the web server step above is done, check: ./oj ps ; ./oj logs web ; ./oj logs api"
exit 1
