#!/usr/bin/env bash
# Start the venue's engine, plus the feed pusher.
#
#   bash app/run-keepers.sh          # start
#   pkill -f "app/keeper.ts"         # stop
#
# Log lands in app/.keeper-hub.log.
#
# **One keeper drives every market in the hub**, and the plural in this
# script's name is history. There used to be one process per market, which was
# never buying isolation: everything that carries risk is hub-scoped — one risk
# engine, one asset-slot slab, one clock, one portfolio per trader — and only
# six accounts are actually per-market. So N processes ran the same full
# `getProgramAccounts` portfolio scan N times every fifteen seconds and spawned
# N makers at once, which is enough load on its own to exhaust a public RPC's
# connection limit, 429 the makers before they can read their own balance, and
# leave every book empty. Nine markets did exactly that on 2026-08-05.
#
# Markets come from ANQA_MARKETS ("id:asset:feed,…") or default to the hub's
# nine, so a hundred markets is a longer string, not a hundred processes.

set -euo pipefail
cd "$(dirname "$0")/.."

GROUP=${ANQA_GROUP:-920}

# The long-tail feeds have no devnet sponsor — one pusher keeps every feed's
# fixed shard-0 account fresh.
ANQA_PUSH_LOOP_SECS=120 nohup npx ts-node --transpile-only app/push-feed.ts \
  >"app/.push-feed.log" 2>&1 &
echo "feed pusher pid $!"

ANQA_GROUP=$GROUP nohup npx ts-node --transpile-only app/keeper.ts \
  >"app/.keeper-hub.log" 2>&1 &
echo "keeper pid $! — hub $GROUP, every market"

echo "tail app/.keeper-hub.log to watch it"
