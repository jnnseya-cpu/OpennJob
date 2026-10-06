# Deploying on a Hostinger VPS (recommended for the pilot)

One Linux server runs everything with Docker Compose (`docker-compose.prod.yml`):
PostgreSQL, a one-shot migration, the API (internal only), the web app behind Caddy
(automatic HTTPS, security headers, `/api` proxied to the API on the same origin) and a
nightly database backup.

**Status: written, not executed.** The images and the compose file were not run where this was
written (no Docker daemon). `docker compose config` validates the file. Follow each step and check
its result; report anything that differs.

## 1. Server and domain

- A Hostinger **KVM VPS** with Ubuntu 24.04. 2 vCPU / 8 GB (KVM 2) is a comfortable start; KVM 1
  (1 vCPU / 4 GB) works for one pilot user. Pick the data centre in the UK or EU.
- A domain or subdomain, e.g. `app.example.org`. In the DNS panel create an **A record** pointing
  it to the VPS's IPv4 address (and AAAA for IPv6 if the VPS has one). Wait until
  `dig +short app.example.org` returns the VPS address.

## 2. First login and hardening

```bash
ssh root@VPS_IP
adduser deploy && usermod -aG sudo deploy
# copy your SSH public key to /home/deploy/.ssh/authorized_keys, then:
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config && systemctl restart ssh
apt update && apt -y upgrade && apt -y install ufw unattended-upgrades git
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
dpkg-reconfigure -plow unattended-upgrades
```

## 3. Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy      # log out and back in as deploy
docker compose version
```

## 4. The code and the secrets

```bash
git clone https://github.com/jnnseya-cpu/OpennJob.git && cd OpennJob
cp deploy/env.production.example .env.production && chmod 600 .env.production
openssl rand -base64 48   # OPENNJOB_JWT_SECRET
openssl rand -base64 32   # OPENNJOB_DATA_KEY  — store a copy offline; losing it loses every CV
openssl rand -base64 24   # POSTGRES_PASSWORD
nano .env.production      # DOMAIN, ACME_EMAIL, the three secrets, OPENNJOB_REGISTRATION_ALLOWLIST
```

`OPENNJOB_REGISTRATION_ALLOWLIST` holds the invited address(es): only they can register.

## 5. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs migrate   # "migrations: 3 applied"
curl -s https://app.example.org/api/health      # {"status":"ok","persistence":"postgres","database":"up"}
```

Open `https://app.example.org`: the landing page. Register with the invited address.

## 6. Backups and a restore test

Dumps land in `./backups` every 24 hours (14 kept). Copy them off the server, e.g. nightly with
`rclone` or `scp` to other storage. **Restore one before relying on them:**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  sh -c 'createdb -U opennjob restore_check && pg_restore -U opennjob -d restore_check' < backups/LATEST.dump
docker compose -f docker-compose.prod.yml --env-file .env.production exec postgres psql -U opennjob -d restore_check -c 'select count(*) from users'
docker compose -f docker-compose.prod.yml --env-file .env.production exec postgres dropdb -U opennjob restore_check
```

CV text, passports and statements in a dump stay encrypted with `OPENNJOB_DATA_KEY`; the key is not
in the dump. Without the key, a restored database cannot be read.

## 7. Updates

```bash
git pull && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Migrations run on every start; the API refuses to start on a database that is behind.

## 8. Still needed before real use

Uptime monitoring and alerting (e.g. an external check on `/api/health`), log retention, the
legal documents, and the rest of `GO-LIVE.md` "Before the first real user".
