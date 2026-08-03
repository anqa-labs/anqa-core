#!/usr/bin/env bash
# Launch one keeper per market of hub 820. Each keeper cranks its asset,
# relays its feed, sweeps its two domains and requotes its maker.
#
#   bash app/run-keepers.sh          # start all nine
#   pkill -f "app/keeper.ts"         # stop them
#
# Logs land in app/.keeper-<id>.log.

set -euo pipefail
cd "$(dirname "$0")/.."

GROUP=880

# The long-tail feeds have no devnet sponsor — one pusher keeps every feed's
# fixed shard-0 account fresh (addresses below come from it).
ANQA_PUSH_LOOP_SECS=120 nohup npx ts-node --transpile-only app/push-feed.ts \
  >"app/.push-feed.log" 2>&1 &
echo "feed pusher pid $!"

# id  sym   asset lots   feed account (fixed)
TABLE=(
  "880 BTC  0 2500  4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"
  "881 SOL  1 6900  7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
  "882 ETH  2 2700  42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC"
  "883 XRP  3 10000 Ae3LGcV5Wt5Z11xvhxSX1h65uNyjuX4qYFFbgifLx5eX"
  "884 DOGE 4 15000 681QkKLoAQrB5h23Ewq9c8rjM19RBuzqwXZf2RPr9Pyw"
  "885 LINK 5 12000 7bWHpGtb2j3jqbpA5gFctdmgZELubiZDBxmt1pEzkBHR"
  "886 AVAX 6 15000 HUBqpBf3aGJdVQndFHmMUd1eMcixt7S4swYPCx8A93K1"
  "887 SUI  7 15000 GgV3a7YeVRga9prjNGEDBG9NwatSaD8rwjZ4GNjPiXTq"
  "888 BNB  8 2500  A3qp5QG9xGeJR1gexbW9b9eMMsMDLzx3rhud9SnNhwb4"
)

for row in "${TABLE[@]}"; do
  read -r id sym asset lots feed <<<"$row"
  ANQA_DEMO_MARKET=$id ANQA_GROUP=$GROUP ANQA_ASSET_INDEX=$asset ANQA_MAKER_LOTS=$lots \
    ANQA_FEED_ACCT="$feed" nohup npx ts-node --transpile-only app/keeper.ts \
    >"app/.keeper-$id.log" 2>&1 &
  echo "keeper $sym ($id, asset $asset) pid $!"
done

echo "all keepers launched — tail app/.keeper-<id>.log to watch one"
