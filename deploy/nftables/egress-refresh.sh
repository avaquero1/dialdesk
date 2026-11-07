#!/usr/bin/env bash
# Refills control's egress sets (set inet vha allow_<name>, deploy/nftables/control.nft) from the egress table
# (deploy/egress-hosts.ts writes it). Run by vha-egress-refresh.timer every few minutes, as root.
#
#   egress-refresh.sh [--dry-run | --check]
#     --dry-run   print the nft script and the summary; change nothing (no nft, no state file)
#     --check     the same, then `nft -c -f` the script (needs the table loaded, e.g. in a test netns)
#
# - Resolves every host (IPv4; the egress bridge has no IPv6). An address seen in the last 6 h is kept, so a CDN
#   that rotates its addresses or a DNS failure doesn't cut a container off between runs.
# - Drops addresses that aren't public (private, loopback, link-local, CGNAT, multicast, reserved): a feed host that
#   resolves to 10.x must not open a path into the VPC.
# - Rebuilds every set (flush + add) in ONE nft transaction: either all sets change or none does.
# - A host that is no longer in the table loses its addresses at once.
#
# Environment (the defaults are the production paths):
#   VHA_EGRESS_HOSTS     the table, `<set> <host>` lines        (/etc/vha/nft/egress-hosts.txt)
#   VHA_EGRESS_STATE     addresses seen, `<set> <host> <ip> <epoch>` (/var/lib/vha/egress/seen)
#   VHA_EGRESS_KEEP      seconds an address is kept after it was last seen (21600 = 6 h)
#   VHA_RESOLVE          the resolver command; the host is appended (getent ahostsv4)
#   VHA_NOW              the time, epoch seconds (tests)
set -euo pipefail

SETS="caddy models markets connections audit board"   # = EGRESS_SETS in deploy/egress-hosts.ts
HOSTS="${VHA_EGRESS_HOSTS:-/etc/vha/nft/egress-hosts.txt}"
STATE="${VHA_EGRESS_STATE:-/var/lib/vha/egress/seen}"
KEEP="${VHA_EGRESS_KEEP:-21600}"
NOW="${VHA_NOW:-$(date +%s)}"
read -r -a RESOLVE <<< "${VHA_RESOLVE:-getent ahostsv4}"

mode=apply
case "${1:-}" in
  "") ;;
  --dry-run) mode=dry-run ;;
  --check) mode=check ;;
  *) echo "usage: egress-refresh.sh [--dry-run | --check]" >&2; exit 2 ;;
esac

die() { echo "egress-refresh: $*" >&2; exit 2; }
[ -r "$HOSTS" ] || die "no egress table at $HOSTS (deploy.sh writes it with deploy/egress-hosts.ts)"
[[ "$KEEP" =~ ^[0-9]+$ && "$NOW" =~ ^[0-9]+$ ]] || die "VHA_EGRESS_KEEP and VHA_NOW must be whole seconds"

work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT

# One run at a time (the timer and a manual run).
if [ "$mode" = apply ]; then
  mkdir -p "$(dirname "$STATE")"
  exec 9> "$STATE.lock"
  flock -w 60 9 || die "another refresh still holds $STATE.lock"
fi

# 1. The table: validate every line before resolving anything.
: > "$work/table"
while read -r set host extra; do
  case "$set" in ""|"#"*) continue ;; esac
  [ -z "${extra:-}" ] || die "bad line in $HOSTS: $set $host $extra"
  [[ " $SETS " == *" $set "* ]] || die "unknown set '$set' in $HOSTS (known: $SETS)"
  [[ "$host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "not a host name in $HOSTS: $host"
  echo "$set $host" >> "$work/table"
done < "$HOSTS"
sort -u -o "$work/table" "$work/table"

# 2. Resolve. Every answer gets the time now.
: > "$work/fresh"
: > "$work/unresolved"
cut -d' ' -f2 "$work/table" | sort -u | while read -r host; do
  if out="$("${RESOLVE[@]}" "$host" 2>/dev/null)"; then
    awk -v h="$host" '$1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print h, $1 }' <<< "$out" | sort -u >> "$work/fresh"
  fi
  awk -v h="$host" '$1 == h { f = 1 } END { exit !f }' "$work/fresh" || echo "$host" >> "$work/unresolved"
done

# 3. Merge with what was seen before: fresh answers, plus old ones younger than KEEP for hosts still in the table.
#    Then drop every address that isn't public. Output: `<set> <host> <ip> <epoch>`, newest epoch per address.
[ -r "$STATE" ] && cp "$STATE" "$work/old" || : > "$work/old"
awk -v now="$NOW" -v keep="$KEEP" '
  function public(ip,   o, i, a, b) {
    if (split(ip, o, ".") != 4) return 0
    for (i = 1; i <= 4; i++) if (o[i] !~ /^[0-9]+$/ || o[i] + 0 > 255) return 0
    a = o[1] + 0; b = o[2] + 0
    if (a == 0 || a == 10 || a == 127 || a >= 224) return 0
    if (a == 100 && b >= 64 && b <= 127) return 0
    if (a == 169 && b == 254) return 0
    if (a == 172 && b >= 16 && b <= 31) return 0
    if (a == 192 && b == 168) return 0
    if (a == 192 && b == 0 && o[3] + 0 == 0) return 0
    if (a == 198 && (b == 18 || b == 19)) return 0
    return 1
  }
  FILENAME == ARGV[1] { sets[$2] = sets[$2] " " $1; next }                # table: host -> sets
  FILENAME == ARGV[2] { seen[$1 " " $2] = now; next }                      # fresh: host ip
  FILENAME == ARGV[3] {                                                    # old: set host ip epoch
    if (NF != 4 || $4 !~ /^[0-9]+$/ || now - $4 >= keep) next
    k = $2 " " $3
    if (!(k in seen) || seen[k] < $4 + 0) seen[k] = $4 + 0
    next
  }
  END {
    for (k in seen) {
      split(k, p, " ")
      if (!(p[1] in sets)) continue
      if (!public(p[2])) { print "egress-refresh: " p[1] " resolved to " p[2] ", not a public address: left out" > "/dev/stderr"; continue }
      n = split(sets[p[1]], s, " ")
      for (j = 1; j <= n; j++) print s[j], p[1], p[2], seen[k]
    }
  }
' "$work/table" "$work/fresh" "$work/old" | sort -u > "$work/state"

# 4. The nft script: every set, flushed and refilled, in one file (= one transaction).
{
  echo "# egress-refresh.sh, $(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)"
  for set in $SETS; do
    echo "flush set inet vha allow_$set"
    ips="$(awk -v s="$set" '$1 == s { print $3 }' "$work/state" | sort -u -t. -k1,1n -k2,2n -k3,3n -k4,4n | paste -sd, - | sed 's/,/, /g')"
    [ -z "$ips" ] || echo "add element inet vha allow_$set { $ips }"
  done
} > "$work/egress.nft"

summary() {
  for set in $SETS; do
    hosts="$(awk -v s="$set" '$1 == s' "$work/table" | wc -l)"
    ips="$(awk -v s="$set" '$1 == s { print $3 }' "$work/state" | sort -u | wc -l)"
    echo "egress-refresh: allow_$set: $hosts hosts, $ips addresses"
  done
  while read -r host; do
    if awk -v h="$host" '$2 == h { f = 1 } END { exit !f }' "$work/state"; then
      echo "egress-refresh: $host: no answer now, kept its addresses from the last $((KEEP / 3600)) h"
    else
      echo "egress-refresh: warning: $host has no address, so its containers can't reach it"
    fi
  done < "$work/unresolved"
}

case "$mode" in
  dry-run)
    cat "$work/egress.nft"; summary ;;
  check)
    cat "$work/egress.nft"; summary
    nft -c -f "$work/egress.nft" && echo "egress-refresh: nft -c passed" ;;
  apply)
    nft -f "$work/egress.nft"
    # The state changes only after nft took the new sets.
    install -m 0600 "$work/state" "$STATE.new" && mv -f "$STATE.new" "$STATE"
    summary ;;
esac
