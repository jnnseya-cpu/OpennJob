# Winding OpennJob down

If you decide to stop, this makes sure nothing keeps running or charging. The steps are safe
to run in order and do not delete anyone's data unless you ask them to.

Most of it is one command on the server; two parts only you can do (your Anthropic account,
and clicking Export/Delete in the app).

## On the server (one command)

```bash
cd /opt/opennjob && bash deploy/decommission.sh        # asks before each step
# or: bash deploy/decommission.sh --yes                # no questions
```

It does three things:

1. **Auto-update off** — turns off the `opennjob-update.timer`, so no new version deploys.
2. **AI keys blanked** — empties `ANTHROPIC_API_KEY` (and any Gemini/OpenAI key) in
   `.env.production`, keeping a dated backup copy on the machine. OpennJob can no longer call a
   paid AI even if a container restarts.
3. **Containers down** — `./oj down`. The site goes offline. The database **volume is kept**, so
   nothing is lost; you can bring it back with `./oj up -d --build`.

## Only you can do these

- **Cap or revoke the AI key at the provider.** Blanking it on the server stops OpennJob using
  it, but your key still exists at Anthropic. Go to `console.anthropic.com` → Billing and set a
  low or $0 limit, or API keys → revoke the key. This is what guarantees no further AI charges.
- **Export or delete account data.** While the site is up, each person uses **Account → Export**
  to download everything held, or **Account → Delete account** to remove it. Do this *before*
  step 3, or bring the site back up (`./oj up -d --build`) to do it, then run step 3 again.

## If you want nothing left at all

After everyone has exported what they need:

```bash
cd /opt/opennjob
rm -f backups/*.dump      # delete the local database backups
./oj down -v              # delete the database volume — NO undo
```

Then, outside the server: cancel the VPS if you no longer need it, remove the DNS record for the
domain, and revoke the AI key at the provider as above.

## Coming back later

Nothing above is irreversible except `./oj down -v` and deleting the backups. To restart:
put a real key back with `bash deploy/set-keys.sh claude`, then `./oj up -d --build`, and if you
want automatic updates again, `bash deploy/enable-auto-update.sh`.
