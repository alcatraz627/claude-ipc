#!/usr/bin/env bash
# Snapshot of claude-ipc's delivery health — the numbers that define the
# turn-based-wake pain (activation reports 01 + 06): how much mail sticks in
# `queued`, how asks resolve, and whether stuck mail belongs to sessions that
# were still alive or ones that closed. Run bare for all-time, or with
# --since <YYYY-MM-DD|epoch> to measure only traffic after a cutoff (e.g. the
# 2026-07-11 wake-plugin deployment) so before/after comparisons stay honest.
#
# Read-only: opens the broker DB in ro mode, safe alongside a live broker.
# New delivery states / close reasons (surfaced, parked, …) appear in the
# group-bys automatically.
set -euo pipefail

DB="${CLAUDE_IPC_HOME:-$HOME/.claude-ipc}/data/ipc.sqlite"
SINCE_RAW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE_RAW="$2"; shift 2 ;;
    --db) DB="$2"; shift 2 ;;
    *) echo "usage: ipc-metrics.sh [--since <YYYY-MM-DD|epoch>] [--db <path>]" >&2; exit 2 ;;
  esac
done
[ -r "$DB" ] || { echo "ipc-metrics: no readable DB at $DB" >&2; exit 1; }

SINCE=0
if [ -n "$SINCE_RAW" ]; then
  case "$SINCE_RAW" in
    *[!0-9.]*) SINCE="$(date -j -f '%Y-%m-%d' "$SINCE_RAW" '+%s' 2>/dev/null)" ||
      { echo "ipc-metrics: cannot parse --since '$SINCE_RAW' (want YYYY-MM-DD or epoch)" >&2; exit 2; } ;;
    *) SINCE="$SINCE_RAW" ;;
  esac
fi

q() { sqlite3 -readonly "$DB" "$1"; }

echo "# ipc-metrics — $(date '+%Y-%m-%d %H:%M') · db: $DB"
[ "$SINCE" != "0" ] && echo "window: messages since $SINCE_RAW (epoch $SINCE)" || echo "window: all-time"
echo

echo "## Delivery states (per recipient delivery)"
q "select d.state, count(*),
     round(100.0*count(*)/(select count(*) from deliveries dd join messages mm on mm.id=dd.msg_id where mm.ts>=$SINCE),1)||'%'
   from deliveries d join messages m on m.id=d.msg_id
   where m.ts>=$SINCE group by d.state order by count(*) desc;" | column -t -s'|'
STUCK=$(q "select ifnull(round(100.0*sum(case when d.state='queued' then 1 else 0 end)/count(*),1),0)
  from deliveries d join messages m on m.id=d.msg_id where m.ts>=$SINCE;")
echo "headline: stuck-at-queued = ${STUCK}%"
echo

echo "## Ask outcomes (awaiting close reasons)"
q "select coalesce(nullif(a.closed_reason,''),case a.closed when 0 then 'OPEN' else 'closed-unspecified' end), count(*)
   from awaiting a join messages m on m.id=a.origin_id
   where m.ts>=$SINCE group by 1 order by count(*) desc;" | column -t -s'|'
ASK=$(q "select ifnull(round(100.0*sum(case when closed_reason='responded' then 1 else 0 end)/nullif(sum(a.closed),0),1),'n/a')
  from awaiting a join messages m on m.id=a.origin_id where m.ts>=$SINCE;")
echo "headline: ask success (responded / closed) = ${ASK}%"
echo

echo "## Stuck mail by recipient liveness (queued only; last_seen proxy per report 01 §4)"
q "select case
     when r.alias is null then 'recipient no longer in registry'
     when r.last_seen >= m.ts then 'recipient alive AFTER send (idle/missed)'
     else 'recipient never seen after send (likely closed)'
   end, count(*)
   from deliveries d join messages m on m.id=d.msg_id
   left join registry_snapshot r on r.alias=d.to_alias
   where d.state='queued' and m.ts>=$SINCE group by 1 order by count(*) desc;" | column -t -s'|'
