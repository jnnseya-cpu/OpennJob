# opennjob.com: DNS, HTTPS and e-mail

The app is served at `https://opennjob.com`. `support@opennjob.com` is the contact and inbox
address. It also receives HTTPS certificate notices and operator alerts, and is the sender of the
app's e-mails (verification, password reset, the 09:00 report).

**Status:** written from how Hostinger DNS, Let's Encrypt and Resend work. None of it has been
done or checked yet. The DNS of opennjob.com could not be looked up from where this was written.

## 1. Point the domain at the VPS (Hostinger, Domains, opennjob.com, DNS / Nameservers)

| Type | Name | Value | Why |
|---|---|---|---|
| A | `@` | the VPS's IPv4 address | `https://opennjob.com` |
| AAAA | `@` | the VPS's IPv6 address, only if it has one | the same over IPv6 |

Remove any other A or AAAA record on `@` (for example a Hostinger parking page or website
builder), or the certificate request can reach the wrong server. Leave the **MX** records that
deliver mail to the `support@` inbox alone.

Check from your own computer before running the installer:

```bash
nslookup opennjob.com        # must show the VPS address
```

Caddy gets the certificate for opennjob.com on the first start. `www.opennjob.com` is not
served. To add it later, add an A record for `www` and tell me, so that `www` is redirected.

## 2. Install

On the VPS as root (`deploy/hostinger-vps.md`, quick path):

```bash
curl -fsSL https://raw.githubusercontent.com/jnnseya-cpu/OpennJob/claude/busy-fermat-9hhn11/deploy/install-hostinger.sh -o install.sh
bash install.sh      # press Enter to accept opennjob.com and support@opennjob.com
```

Until step 3 is done the app runs, but e-mail is recorded and **not sent**. Without e-mail nobody
can verify an address, and nothing is submitted for an unverified account.

## 3. Sending e-mail with Resend

1. Create an account at resend.com and add the domain `opennjob.com`. Choose the EU region if
   offered.
2. Resend lists the DNS records to add. Add each **exactly as Resend shows it** in Hostinger
   DNS. It is usually:
   - **DKIM**: a TXT record named like `resend._domainkey`, with a long `p=...` value.
   - **SPF and bounces**: an MX record and a TXT record (`v=spf1 include:amazonses.com ~all`) on
     a sending subdomain such as `send`. They sit on that subdomain, so they do not replace the
     SPF record that `support@` may already have on `@`.
3. Add a DMARC record yourself, starting in monitoring mode:

   | Type | Name | Value |
   |---|---|---|
   | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:support@opennjob.com` |

   If a `_dmarc` record already exists, edit it rather than adding a second one.
4. Wait until Resend shows the domain as **Verified**. Then create an API key with "sending
   access" only.
5. On the VPS:

   ```bash
   cd /opt/opennjob
   nano .env.production          # RESEND_API_KEY=re_...   (leave OPENNJOB_EMAIL_FROM as it is)
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d
   ```

## 4. Prove it (REP-4)

1. Register on `https://opennjob.com` with an invited address you can read.
2. The verification e-mail should arrive from `OpennJob <support@opennjob.com>`. Open it in Gmail,
   then "Show original": it must say **SPF: PASS**, **DKIM: PASS** and **DMARC: PASS**.
3. Follow the link: the account shows "E-mail address confirmed".
4. The next morning, the 09:00 report arrives (London time). If it does not, `docker compose ...
   logs api | grep report` and the operator alert at `support@opennjob.com` say why.

Record the date and result in `GO-LIVE.md` and `docs/traceability.md` (REP-4) only after this
check has passed.

## Mail sent from support@ and to it

The app sends **as** `support@opennjob.com` through Resend; replies arrive in the normal inbox
because the MX records are unchanged. If the inbox is Hostinger Email, its own SPF entry on `@`
stays as it is.
