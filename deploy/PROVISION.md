# PROVISION: the Vultr resources for the live demo

The exact list of what to create on Vultr, in order, with every setting. Whoever holds the Vultr API key creates
them from their own machine; nothing here runs on a server, and **no server ever gets the Vultr API key** (not in
user-data either: the metadata address serves user-data to any process on the VM). Prices are from Vultr's console
or docs as of November 2026; "unknown" means they weren't shown.

Nothing is created before the owner of the account says yes to the total below.

## What it costs

| # | Resource | Plan | Monthly | Hourly | Source |
|---|---|---|---|---|---|
| 1 | VPC network | New York (ewr) | unknown (no price in the docs read) | | |
| 2 | Firewall groups (2) | | unknown (no price in the docs read) | | |
| 3 | control | Cloud Compute, Shared CPU, `vc2-4c-8gb` (4 vCPU, 8 GB, 160 GB SSD, 4 TB transfer) | $40 | $0.060 | console |
| 4 | the sandbox machine | already exists (VX1 `vx1-g-2c-8g`); only attached to the VPC | (already billed) | $0.076 | console |
| 5 | Managed PostgreSQL | Startup `vultr-dbaas-startup-cc-1-55-2` (1 vCPU, 2 GB, 97 connections), 0 replicas | $30 | $0.04 | console |
| 6 | Object Storage | Standard (1,000 GB storage and 1,000 GB egress included) | $18 | | docs |
| 7 | Container Registry | **not needed**: deploy.sh builds the images on control | $0 | | |
| 8 | DNS A record | at the domain's DNS host, not Vultr | $0 | | |

**New spend: about $88 a month (about $0.13 an hour), plus the sandbox machine already running.** Extra Object Storage
beyond the allowance: $0.018/GB stored, $0.01/GB egress (docs). A second Object Storage subscription (see 6) adds $18.
The account's limits: at most 5 instances, plans under $200 a month together; this is 2 instances and 1 database.

## Before you start

- The SSH key: the same one already on the sandbox machine (it is already in the account).
- The admin address: the one public IPv4 address SSH is allowed from (`ADMIN_IP` below). It never goes in the repo.
- Region: **New York (ewr)** for everything. A VPC is per region, so the database, control and the sandbox
  machine must all be there.

## 1. VPC network

- Region: New York (ewr).
- Description: `vha`.
- IPv4 range: let Vultr choose (or `10.1.96.0/20`). Write down the range.
- Unknown: whether Managed PostgreSQL can join a "VPC 2.0" network or only a classic VPC. Make the kind the database
  form offers in step 5 (check the form first if you can).

## 2. Firewall groups

Vultr Firewall filters inbound traffic only. Outbound is the job of each machine's own nftables rules: the sandbox machine's are enforced, and control's log and don't block (`README.md`, "Deploying control").

**`vha-control`**, for control:

| Protocol | Port | Source | Why |
|---|---|---|---|
| TCP | 22 | `ADMIN_IP`/32 | SSH, from the admin address only |
| TCP | 443 | anywhere (0.0.0.0/0) | the web app (Caddy). The certificate also comes over 443 (TLS-ALPN-01) |

Nothing else: no port 80, no UDP, no IPv6 rules (IPv6 stays off).

**The sandbox machine's group** (it already has one): keep TCP 22 from `ADMIN_IP`/32, and nothing public. Add one rule
after step 3, when control's VPC address is known:

| Protocol | Port | Source | Why |
|---|---|---|---|
| TCP | 8200 | control's VPC address /32 | runner calls sandbox-manager. Only needed if Vultr Firewall filters VPC traffic (unknown); it opens nothing to the internet |

## 3. control

| Setting | Value |
|---|---|
| Type | Cloud Compute, Shared CPU |
| Plan | `vc2-4c-8gb` |
| Location | New York (ewr) |
| Image | Ubuntu 24.04 LTS x64 (plain, no marketplace app) |
| SSH key | the existing one (see above) |
| Label / hostname | `vha-control` |
| VPC | the network from step 1 |
| Firewall group | `vha-control` |
| IPv6 | off |
| Automatic backups | off (costs extra; backups are Phase V2) |
| DDoS protection | off |
| User data / cloud-init | **none** |

After it boots, over SSH as root:

```sh
apt-get update && apt-get install -y ca-certificates curl nftables
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
ip -br addr        # the public interface (PUBLIC_IF) and the VPC interface (VPC_IF), with their addresses
```

If the VPC interface has no address, configure it as Vultr's VPC docs describe (Ubuntu: netplan) before going on.

## 4. The sandbox machine: join the VPC

- Attach the existing sandbox machine to the VPC from step 1. Nothing else changes on it here.
- Then check its VPC interface has an address (`ip -br addr`). An instance that is already running may need a reboot or
  a netplan entry for the new interface (unknown which).

## 5. Managed PostgreSQL

| Setting | Value |
|---|---|
| Engine | PostgreSQL 18 (any 16 or newer works: db-init.sql needs `GRANT ... WITH SET`) |
| Plan | Startup, `vultr-dbaas-startup-cc-1-55-2` (1 vCPU, 2 GB, 97 connections). Not Hobbyist: 8 services × 3 connections = 24, Hobbyist allows 22 |
| Replicas | **0** (the form starts at 1) |
| Location | New York (ewr) |
| VPC | the network from step 1 |
| Label | `vha-db` |
| Trusted sources | control's VPC address only (/32). Unknown: whether the form accepts a private address; if it takes only public ones, use control's public IPv4 |

Write down the **private (VPC) host name**, the port, the database name (`defaultdb`) and the admin user (`vultradmin`).
Unknown: whether it counts toward the 5-instance limit.

## 6. Object Storage

| Setting | Value |
|---|---|
| Tier | Standard |
| Location | New Jersey (ewr1, endpoint `https://ewr1.vultrobjects.com`), the one closest to the ewr machines |
| Label | `vha-objects` |

- **Don't make the buckets.** `deploy/s3-bucket.ts` makes both on the first deploy, because the heads bucket must be
  made with object lock and lock can only be chosen when a bucket is made. Pick two names that are free
  (for example `vha-screenshots-<random>` and `vha-heads-<random>`) and put them in deploy.env.
- Unknown: whether Vultr's storage supports object lock (COMPLIANCE) and `If-None-Match` writes. Checked live in
  milestone V1.2; if lock isn't there, s3-bucket.ts stops with a clear error and audit keeps its write-once folder.
- One subscription has one key, and it reaches both buckets. For a key per bucket (the secrets map's goal), make a
  second subscription ($18 more) or check whether Vultr can scope a key to one bucket (unknown). Until then the same
  key file is used twice.

## 7. Container Registry

Not needed: `deploy.sh` builds the images on control from the copied repo. Don't create one.

## 8. DNS

At the DNS host of `vaquerothe.dev`:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `vultrcontest` | control's public IPv4 | 300 |

No AAAA record. If the domain has a CAA record, it must allow `letsencrypt.org`.

## What comes back, and where it goes

Send back **addresses and ids only**: control's public and VPC IPv4, the sandbox machine's VPC IPv4, the VPC range,
the database's private host, port, database and admin user, the bucket names, and each resource's id. They go into
`/etc/vha/deploy.env` on control (from `deploy/deploy.env.example`), never into the repo.

The secrets never travel by mail or chat. They go straight onto control over SSH, as root, mode 0600, into
`/etc/vha/inputs/`:

| File | What | Format |
|---|---|---|
| `pg-admin.pgpass` | the database admin password | one line `host:port:defaultdb:vultradmin:password` (escape `:` and `\` in the password with `\`) |
| `s3-screenshots`, `s3-heads` | the Object Storage key (the same key twice until there are two) | `access_key_id=...` and `secret_access_key=...` lines |
| `vultr-inference` | the Serverless Inference key | the key alone |
| `brave-search` | the Brave Search key (optional) | the key alone |

## Checks, from control, once everything exists (milestone V1.2)

```sh
ping -c1 <sandbox VPC address>                                         # the VPC works
docker run --rm -e PGPASSFILE=/p -v /etc/vha/inputs/pg-admin.pgpass:/p:ro postgres:17.6-alpine \
  psql "host=<db private host> port=<port> dbname=defaultdb user=vultradmin sslmode=require" -c 'select version()'
getent hosts vultrcontest.vaquerothe.dev                               # control's public address
```

Object Storage is checked by the first deploy (`s3-bucket.ts` makes and reads back both buckets). Then:
`deploy/scripts/deploy.sh push` (see `deploy/README.md`).
