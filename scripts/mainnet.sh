#!/usr/bin/env bash
#
# The mainnet deploy, in one command, with every check that matters run first.
#
# This is the most consequential deploy this project will do: it is the moment
# the vaults stop holding test SOL and start holding money, and the program
# address it lands on is baked into the server, the IDL, every card and every
# market permalink already published. So the default here is CHECK, not deploy.
#
#   ./scripts/mainnet.sh check     what would happen, what it costs, what is missing
#   ./scripts/mainnet.sh backup    where the one irreplaceable file is
#   ./scripts/mainnet.sh deploy    the real thing, after check passes
#   ./scripts/mainnet.sh verify    prove production actually moved
#
# It never prints secret key material. `solana address -k` reads a keypair and
# prints only its public key, which is what every balance check here uses.

set -euo pipefail
cd "$(dirname "$0")/.."

PROGRAM_ID="3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu"
KEYPAIR="onchain/target/deploy/oddie_chain-keypair.json"
SO="onchain/target/deploy/oddie_chain.so"
DEPLOY_WALLET="${DEPLOY_WALLET:-$HOME/.config/solana/id.json}"
ADMIN_PUBKEY="J3bEmhdy7CeZeJRXHSJe2JEDyC39kmEWfBKUrYCQuPVY"
MAINNET="${MAINNET_RPC:-mainnet-beta}"
# ANCHOR AND SOLANA DO NOT SPEAK THE SAME DIALECT.
#
# `solana --url` takes mainnet-beta. `anchor --provider.cluster` does not: its
# aliases are localnet, testnet, mainnet, devnet, and anything else has to be a
# full http(s) url. So every check in this script passed against mainnet-beta
# and the deploy itself died on the one line that hands the name to anchor,
# AFTER the confirmation prompt and with the wallets already funded. Nothing was
# spent, which is the only reason this was a nuisance rather than an incident.
#
# Resolved once, here, into the spelling each tool actually accepts. A custom
# MAINNET_RPC is already a url, and anchor takes urls, so it passes through.
case "$MAINNET" in
  mainnet-beta|mainnet) ANCHOR_CLUSTER="mainnet" ;;
  *)                    ANCHOR_CLUSTER="$MAINNET" ;;
esac
BASE="https://oddie.fun"

# Headroom for future upgrades, as a multiple of the current binary. A program
# account cannot grow after deploy without a reallocation, and 1.2x costs a
# fraction of a SOL more today against not being able to ship a fix later.
HEADROOM="${HEADROOM:-1.2}"

ok=0; fail=0
say()  { printf "  %s\n" "$*"; }
good() { printf "  \033[32m OK \033[0m %s\n" "$*"; ok=$((ok+1)); }
bad()  { printf "  \033[31mMISS\033[0m %s\n" "$*"; fail=$((fail+1)); }
head_() { printf "\n\033[1m%s\033[0m\n" "$*"; }

sol_of() { solana balance "$1" --url "$2" 2>/dev/null | awk '{print $1}'; }
rent_for() { solana rent "$1" --url "$MAINNET" 2>/dev/null | awk '/Rent-exempt/{print $3}'; }

preflight() {
  head_ "toolchain"
  command -v anchor >/dev/null && good "anchor $(anchor --version | awk '{print $2}')" || bad "anchor is not installed"
  command -v solana >/dev/null && good "solana $(solana --version | awk '{print $2}')" || bad "solana is not installed"

  head_ "the tree"
  # Tracked files only. Untracked brand sources (decks, sticker PNGs) sit in
  # the tree on purpose and cannot change what anchor builds; counting them
  # made this a permanent false blocker.
  if [ -z "$(git status --porcelain --untracked-files=no)" ]; then
    good "working tree is clean, so this deploy is reproducible from $(git rev-parse --short HEAD)"
  else
    bad "tracked files are modified. Commit first: a deployed binary you cannot rebuild is a binary you cannot audit"
  fi

  head_ "the program id, in all three places it is written down"
  local in_src in_toml in_key
  in_src=$(grep -o 'declare_id!("[^"]*")' onchain/programs/oddie_chain/src/lib.rs | sed 's/.*("\(.*\)").*/\1/')
  in_toml=$(grep -o '"[1-9A-HJ-NP-Za-km-z]\{32,44\}"' onchain/Anchor.toml | head -1 | tr -d '"')
  [ "$in_src"  = "$PROGRAM_ID" ] && good "lib.rs declare_id"      || bad "lib.rs says $in_src"
  [ "$in_toml" = "$PROGRAM_ID" ] && good "Anchor.toml"            || bad "Anchor.toml says $in_toml"
  if [ -f "$KEYPAIR" ]; then
    in_key=$(solana address -k "$KEYPAIR")
    [ "$in_key" = "$PROGRAM_ID" ] && good "the deploy keypair derives to it" || bad "keypair derives to $in_key"
  else
    bad "$KEYPAIR is MISSING. Without it this program id can never be deployed or upgraded again"
  fi

  head_ "the binary"
  if [ -f "$SO" ]; then
    local bytes; bytes=$(wc -c < "$SO" | tr -d ' ')
    good "built, $bytes bytes"
    MAX_LEN=$(python3 -c "print(int($bytes * $HEADROOM))")
    RENT=$(rent_for "$MAX_LEN")
    # AN UPGRADE ASKS A DIFFERENT MONEY QUESTION THAN A FIRST DEPLOY.
    #
    # A program account is sized when it is created and cannot grow on its own.
    # If the new binary is bigger than the account holding the old one, the
    # deploy fails, and the fix costs rent on the difference, permanently. The
    # first deploy of this program landed at EXACTLY its own size, because
    # anchor's deprecated path dropped --max-len, so the very next upgrade of
    # any size runs into this.
    ON_CHAIN_LEN=$(solana program show "$PROGRAM_ID" --url "$MAINNET" 2>/dev/null | awk '/Data Length/{print $3}')
    if [ -n "$ON_CHAIN_LEN" ]; then
      if [ "$bytes" -gt "$ON_CHAIN_LEN" ]; then
        EXTEND_BY=$(python3 -c "print($bytes - $ON_CHAIN_LEN)")
        EXTEND_SOL=$(python3 -c "print(round($EXTEND_BY * 6960 / 1e9, 4))")
        say "the account on chain holds ${ON_CHAIN_LEN} bytes and this binary is ${bytes}"
        say "so the upgrade must EXTEND it by ${EXTEND_BY} bytes, costing ${EXTEND_SOL} SOL in rent, permanently"
      else
        EXTEND_BY=0
        say "the account on chain holds ${ON_CHAIN_LEN} bytes and this binary is ${bytes}: it fits, no extension"
      fi
    else
      say "will allocate ${MAX_LEN} bytes (${HEADROOM}x) costing ${RENT} SOL in rent"
    fi
    say "that rent is RECOVERABLE with: solana program close $PROGRAM_ID --url $MAINNET"
  else
    bad "$SO is missing. Run: cd onchain && anchor build"
    RENT="3.5"
  fi

  head_ "money"
  local dep_pk dep_bal admin_bal need
  dep_pk=$(solana address -k "$DEPLOY_WALLET" 2>/dev/null || echo "")
  if [ -z "$dep_pk" ]; then bad "no deploy wallet at $DEPLOY_WALLET"; else
    dep_bal=$(sol_of "$dep_pk" "$MAINNET")
    # AN UPGRADE DOES NOT PAY THE PROGRAM'S RENT AGAIN. The account already
    # holds it. What an upgrade costs is rent on the bytes it grows by, plus
    # fees, and asking for the full first-deploy figure would have sent somebody
    # to fund 2.4 SOL for a 0.16 SOL operation.
    if [ -n "${ON_CHAIN_LEN:-}" ]; then
      need=$(python3 -c "print(round(${EXTEND_SOL:-0} + 0.05, 4))")
    else
      need=$(python3 -c "print(round($RENT + 0.05, 4))")   # rent plus transaction fees
    fi
    say "deploy wallet  $dep_pk"
    if python3 -c "import sys; sys.exit(0 if float('$dep_bal') >= float('$need') else 1)"; then
      good "has $dep_bal SOL on mainnet, needs $need"
    else
      bad "has $dep_bal SOL on mainnet, needs $need (short by $(python3 -c "print(round(float('$need')-float('$dep_bal'),4))"))"
    fi
  fi

  # The admin key is a SEPARATE wallet and a separate failure: the deploy can
  # succeed and then every market mint fails for want of rent, which looks like
  # a broken product rather than an empty wallet.
  admin_bal=$(sol_of "$ADMIN_PUBKEY" "$MAINNET")
  say "admin wallet   $ADMIN_PUBKEY  (mints markets)"
  if python3 -c "import sys; sys.exit(0 if float('$admin_bal') >= 0.1 else 1)"; then
    good "has $admin_bal SOL, about $(python3 -c "print(int(float('$admin_bal')/0.004))") markets' worth of rent"
  elif [ -n "${ON_CHAIN_LEN:-}" ] && python3 -c "import sys; sys.exit(0 if float('$admin_bal') >= 0.02 else 1)"; then
    # An upgrade mints nothing, so a thin admin wallet must not block it. Still
    # said out loud, because a deployment that cannot open a market is a broken
    # product either way.
    say "  ! has $admin_bal SOL, about $(python3 -c "print(int(float('$admin_bal')/0.004))") markets left. Top it up soon; it does not block an upgrade"
  else
    bad "has $admin_bal SOL. Every market costs ~0.004 SOL to mint, so at this balance nothing can be created"
  fi

  head_ "is it already up there"
  if solana program show "$PROGRAM_ID" --url "$MAINNET" >/dev/null 2>&1; then
    local auth; auth=$(solana program show "$PROGRAM_ID" --url "$MAINNET" | awk '/Authority/{print $2}')
    say "the program EXISTS on mainnet, authority $auth"
    if [ "$auth" = "$dep_pk" ]; then good "we hold the upgrade authority, so deploy would be an UPGRADE"
    else bad "upgrade authority is not our deploy wallet. This deploy would fail"; fi
  else
    good "not deployed yet, this would be a first deploy"
  fi

  head_ "$ok passed, $fail blocking"
  [ "$fail" -eq 0 ]
}

case "${1:-check}" in
  check)
    preflight && { echo; say "Everything is ready. Run: ./scripts/mainnet.sh deploy"; } \
              || { echo; say "Fix the MISS lines above first."; exit 1; }
    ;;

  backup)
    head_ "the one file that cannot be replaced"
    say "$KEYPAIR"
    say ""
    say "It is gitignored and exists only on this machine. Lose it and the program"
    say "id $PROGRAM_ID can never be deployed or upgraded again,"
    say "which strands every market permalink, card and IDL already published."
    say ""
    say "Copy it somewhere durable and private, by hand, now. A password manager"
    say "entry is fine. It is 292 bytes."
    say ""
    say "This script deliberately does not copy it for you: a secret this small"
    say "and this final should move exactly where you decide and nowhere else."
    ;;

  deploy)
    preflight || { echo; say "Refusing to deploy with blocking failures."; exit 1; }
    head_ "deploying to $MAINNET"
    say "This spends real SOL and publishes a program at $PROGRAM_ID."
    printf "  Type the word mainnet to continue: "
    read -r confirm
    [ "$confirm" = "mainnet" ] || { say "Aborted."; exit 1; }

    # Extend FIRST. anchor's auto-extend uses ExtendProgram, which this
    # cluster's loader replaced with ExtendProgramChecked, so it fails with
    # "invalid instruction data" after the confirmation prompt and on a funded
    # wallet. Doing it ourselves with the solana CLI uses the instruction the
    # loader actually accepts.
    if [ "${EXTEND_BY:-0}" -gt 0 ]; then
      head_ "extending the program account by ${EXTEND_BY} bytes"
      solana program extend "$PROGRAM_ID" "$EXTEND_BY" --url "$MAINNET"
    fi

    if [ -n "${ON_CHAIN_LEN:-}" ]; then
      # An upgrade, not a create: --max-len is only meaningful when the account
      # is being made, and passing it to an upgrade is how the first deploy's
      # headroom silently went missing.
      solana program deploy "$SO" --program-id "$KEYPAIR" --url "$MAINNET"
    else
      ( cd onchain && anchor deploy \
          --provider.cluster "$ANCHOR_CLUSTER" \
          --program-name oddie_chain \
          -- --max-len "$MAX_LEN" )
    fi

    head_ "what landed"
    solana program show "$PROGRAM_ID" --url "$MAINNET"

    # Prove the bytes up there are the bytes we built, rather than trusting the
    # deploy's own exit code.
    local_hash=$(shasum -a 256 "$SO" | awk '{print $1}')
    solana program dump "$PROGRAM_ID" /tmp/oddie-mainnet.so --url "$MAINNET" >/dev/null 2>&1
    remote_hash=$(head -c "$(wc -c < "$SO" | tr -d ' ')" /tmp/oddie-mainnet.so | shasum -a 256 | awk '{print $1}')
    [ "$local_hash" = "$remote_hash" ] && good "on-chain bytes match the local build" \
      || bad "on-chain bytes DIFFER from the local build"

    head_ "now flip production, by hand"
    say "The server still points at devnet. Nothing above changed that."
    say ""
    say "  railway variables --set SOLANA_RPC_URL=https://api.mainnet-beta.solana.com -s oddie-hook"
    say ""
    say "Use a paid RPC if you have one: the public endpoint rate-limits under"
    say "any real traffic, and every card render reads a vault."
    say ""
    say "Then, BEFORE anyone reloads the feed:"
    say "  npm run mainnet-backfill -- replay          (dry run)"
    say "  npm run mainnet-backfill -- replay --apply  (re-mint every market at its own address)"
    say "Then: ./scripts/mainnet.sh verify"
    ;;

  verify)
    head_ "what production says"
    status=$(curl -s "$BASE/api/chain/status")
    say "$status"
    echo "$status" | grep -q '"cluster":"mainnet-beta"' \
      && good "the API reports mainnet" || bad "the API still reports devnet, so the env did not take"

    # The cluster is written into the landing copy at BOOT, not per request, so
    # a deploy that changed the variable but did not restart looks correct in
    # the API and still says devnet to every visitor.
    if curl -s "$BASE/" | grep -q "Solana devnet"; then
      bad "the landing page still says devnet. Restart the service: landing.html is read once at boot"
    else
      good "the landing page no longer says devnet"
    fi

    slug=$(curl -s "$BASE/api/v1/markets?limit=1" | python3 -c 'import sys,json;m=json.load(sys.stdin)["markets"];print(m[0]["slug"] if m else "")')
    if [ -n "$slug" ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/card/$slug.png")
      [ "$code" = "200" ] && good "cards still render ($slug)" || bad "card render returned $code"
    fi

    # The board is not moved until every existing market answers on the new
    # cluster. The API reporting mainnet says the env took; it says nothing
    # about whether the markets came with it, and a feed of unreachable cards
    # looks completely healthy from here.
    if [ -f mainnet-backfill.json ]; then
      head_ "every existing market, on the new cluster"
      # UNDER THE DEPLOYMENT'S OWN ENVIRONMENT, not this shell's.
      #
      # This ran a bare `npm run`, which inherits an operator laptop where
      # SOLANA_RPC_URL and DATABASE_URL are unset. So it read the DEFAULT
      # cluster -- devnet, the one we just left -- and reported the mainnet
      # board as missing. The sub-script even says so out loud ("this snapshot
      # came from devnet and that is the cluster this script is pointed at"),
      # and the line above it still printed a red MISS about the move having
      # failed. A check that cannot see the thing it checks does not return
      # "unknown", it returns whatever the fallback happens to be, and here the
      # fallback is the wrong chain.
      #
      # DATABASE_URL is overridden AFTER railway injects it, because the value
      # railway supplies is postgres.railway.internal, which only resolves from
      # inside their network.
      db_pub=$(railway variables --service Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
      if railway run --service oddie-hook -- env DATABASE_URL="$db_pub" npm run --silent mainnet-backfill -- verify; then
        good "every snapshotted market is live with identical terms"
      else
        bad "markets are missing or changed. See above, then: npm run mainnet-backfill -- replay --apply"
      fi
    else
      bad "no mainnet-backfill.json. The markets were never snapshotted, so nothing re-minted them and the whole board is unreachable"
    fi

    head_ "$ok passed, $fail failing"
    [ "$fail" -eq 0 ] && say "Mainnet is live. The number can stop being zero." || exit 1
    ;;

  *) say "usage: ./scripts/mainnet.sh [check|backup|deploy|verify]"; exit 1 ;;
esac
