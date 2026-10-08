#!/usr/bin/env bash
# Add API keys to OpennJob on the server, then restart the API. What the job-search APIs are asked
# comes from each person's CV and places on Profile, not from here:
#
#   cd /opt/opennjob
#   bash deploy/set-keys.sh gemini     # Google Gemini API key (aistudio.google.com): drafts, criteria, interview feedback
#   bash deploy/set-keys.sh adzuna     # Adzuna job search API (free developer key)
#   bash deploy/set-keys.sh reed       # Reed job search API (free developer key)
#   bash deploy/set-keys.sh boards     # employers' own boards on Greenhouse / Lever / Ashby (no key)
#   bash deploy/set-keys.sh reliefweb  # ReliefWeb jobs API (UN OCHA): DR Congo and other countries the others miss
#   bash deploy/set-keys.sh jooble     # Jooble job search API: one free key per country site (UAE, Gulf, Ireland...)
#
# Secrets are typed without being shown and stored only in .env.production (root only).
# The Gemini key is checked with one tiny call. Job sources are not called
# here: a job source may be used only after someone has read its terms (CLAUDE.md rule 5).
set -euo pipefail
cd "${OPENNJOB_DIR:-/opt/opennjob}"
F=.env.production
[ -f "$F" ] && [ -x ./oj ] || { echo "Run deploy/install-hostinger.sh first (no $F or ./oj here)." >&2; exit 1; }

current() { grep -E "^$1=" "$F" | head -1 | cut -d= -f2- | sed "s/^'\\(.*\\)'\$/\\1/; s/^\"\\(.*\\)\"\$/\\1/" || true; }
ask() { local v; read -r -p "$1${2:+ [$2]}: " v </dev/tty; printf '%s' "${v:-${2:-}}"; }
ask_secret() { local v; read -r -s -p "$1 (not shown): " v </dev/tty; echo >&2; printf '%s' "$v"; }
confirm_terms() {
  echo "Before OpennJob may read $1, someone must read its terms of use: $2"
  echo "(attribution, caching and rate limits, and whether this use is allowed). Record the result in docs/sources.md."
  local a; read -r -p "Have you read them, and do they allow this use? [y/N]: " a </dev/tty
  [ "$a" = y ] || [ "$a" = Y ] || { echo "Nothing changed."; exit 1; }
}

# set_values KEY VALUE [KEY VALUE ...]: replace or add each line, single-quoted (taken literally).
set_values() {
  local tmp; tmp="$(mktemp)"; chmod 600 "$tmp"; cp "$F" "$tmp"
  while [ $# -gt 1 ]; do
    case "$2" in *"'"*) echo "A value contains a single quote ('), which the settings file cannot hold. Nothing changed." >&2; rm -f "$tmp"; exit 1 ;; esac
    grep -vE "^$1=" "$tmp" > "$tmp.n" || true; mv "$tmp.n" "$tmp"
    printf "%s='%s'\n" "$1" "$2" >> "$tmp"
    shift 2
  done
  cat "$tmp" > "$F"; rm -f "$tmp"; chmod 600 "$F"
}

restart() { echo "== Restarting the API"; ./oj up -d api >/dev/null; for _ in $(seq 1 20); do ./oj exec -T api true >/dev/null 2>&1 && break; sleep 2; done; }

case "${1:-}" in
  gemini)
    KEY="$(ask_secret 'Google Gemini API key')"
    [ -n "$KEY" ] || { echo "No key given. Nothing changed." >&2; exit 1; }
    MODEL="$(ask 'Model' "$(current OPENNJOB_LLM_MODEL | grep . || echo gemini-2.5-flash)")"
    set_values GEMINI_API_KEY "$KEY" OPENNJOB_LLM_MODEL "$MODEL"
    unset KEY
    # Claude is no longer used: its settings are taken out of the file.
    grep -vE '^(ANTHROPIC_API_KEY|OPENNJOB_MODEL|OPENNJOB_LLM_EFFORT|OPENNJOB_LLM_PROVIDER|OPENAI_API_KEY)=' "$F" > "$F.tmp" || true
    cat "$F.tmp" > "$F"; rm -f "$F.tmp"; chmod 600 "$F"
    restart
    echo "== Gemini is OpennJob's AI. Checking with one tiny call:"
    bash deploy/check-ai.sh | sed -n '/One real call/,$p'
    ;;
  adzuna)
    confirm_terms "Adzuna" "https://developer.adzuna.com (API terms)"
    ID="$(ask 'Adzuna App ID' "$(current ADZUNA_APP_ID)")"
    KEY="$(ask_secret 'Adzuna App Key')"
    [ -n "$ID" ] && [ -n "$KEY" ] || { echo "Both are needed. Nothing changed." >&2; exit 1; }
    set_values ADZUNA_APP_ID "$ID" ADZUNA_APP_KEY "$KEY"
    unset KEY; restart; echo "Saved. Record the terms check in docs/sources.md (date and your name)."
    ;;
  reed)
    confirm_terms "Reed" "https://www.reed.co.uk/developers (API terms)"
    KEY="$(ask_secret 'Reed API key')"
    [ -n "$KEY" ] || { echo "No key given. Nothing changed." >&2; exit 1; }
    set_values REED_API_KEY "$KEY"
    unset KEY; restart; echo "Saved. Record the terms check in docs/sources.md (date and your name)."
    ;;
  boards)
    confirm_terms "employers' public job boards (Greenhouse, Lever, Ashby)" "each provider's job board API terms, and the employer's own"
    echo "Each entry is the board name from the employer's careers page address, optionally ':Employer Name'."
    echo "  e.g. boards.greenhouse.io/examplebuild -> examplebuild:Example Build"
    GH="$(ask 'Greenhouse boards' "$(current OPENNJOB_GREENHOUSE_BOARDS)")"
    LV="$(ask 'Lever companies' "$(current OPENNJOB_LEVER_COMPANIES)")"
    AS="$(ask 'Ashby boards' "$(current OPENNJOB_ASHBY_BOARDS)")"
    set_values OPENNJOB_GREENHOUSE_BOARDS "$GH" OPENNJOB_LEVER_COMPANIES "$LV" OPENNJOB_ASHBY_BOARDS "$AS"
    restart; echo "Saved. Record the terms check in docs/sources.md."
    ;;
  reliefweb)
    confirm_terms "ReliefWeb" "https://apidoc.reliefweb.int and https://reliefweb.int/terms-conditions"
    echo "ReliefWeb needs an appname it approved for you (request it on apidoc.reliefweb.int)."
    NAME="$(ask 'Approved appname' "$(current OPENNJOB_RELIEFWEB_APPNAME)")"
    [ -n "$NAME" ] || { echo "No appname given. Nothing changed." >&2; exit 1; }
    set_values OPENNJOB_RELIEFWEB_APPNAME "$NAME"
    restart; echo "Saved. Record the terms check in docs/sources.md (date and your name)."
    ;;
  jooble)
    confirm_terms "Jooble" "the API terms on each country's site, e.g. https://ae.jooble.org/api/about"
    echo "Each Jooble country site gives its own key, valid only for that country (jooble.org = USA)."
    echo "Get one per country at https://<code>.jooble.org/api/about, e.g. ae for the UAE, uk for the UK."
    CC="$(ask 'Country code (two letters, e.g. AE)')"
    CC="$(printf '%s' "$CC" | tr '[:lower:]' '[:upper:]')"
    [[ "$CC" =~ ^[A-Z]{2}$ ]] || { echo "A two-letter country code is needed. Nothing changed." >&2; exit 1; }
    KEY="$(ask_secret "Jooble API key for $CC")"
    [ -n "$KEY" ] || { echo "No key given. Nothing changed." >&2; exit 1; }
    case "$KEY" in *[,:]*) echo "A key cannot contain ',' or ':'. Nothing changed." >&2; exit 1 ;; esac
    # Keep the other countries' keys; replace this country's.
    REST="$(current JOOBLE_API_KEYS | tr ',' '\n' | grep -v "^$CC:" | grep . | paste -sd, - || true)"
    set_values JOOBLE_API_KEYS "${REST:+$REST,}$CC:$KEY"
    unset KEY; restart; echo "Saved the key for $CC. Run again to add another country. Record the terms check in docs/sources.md."
    ;;
  *)
    sed -n '2,16p' "$0"; exit 1 ;;
esac
