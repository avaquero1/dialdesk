# The sandbox machine

How the sandbox machine is set up, from a dev PC, in one command. It is an Ubuntu 24.04 VM with Docker and gVisor
(runsc, systrap) installed; the backend that ships is `SANDBOX_BACKEND=gvisor` (sandbox/README.md).

```sh
VHA_SANDBOX_HOST=root@<address> VHA_SANDBOX_SSH_KEY=<key file> \
  deploy/sandbox-host/push.sh --ssh-from <your admin address> --with-tests
# then, from a NEW ssh connection, within 5 minutes:
vha-nft-confirm
# and the production path on the real internet (the installed proxy and manager, no dev flags):
/opt/vha/src/current/deploy/sandbox-host/smoke.sh
```

`push.sh` copies `HEAD` as a git archive to `/opt/vha/src/<rev>` (nothing is pushed anywhere) and runs `setup.sh` there.
The machine's address, the key and the admin address stay out of the repo. Run it again to deploy a newer commit.

## What setup.sh puts on the machine

| What | Where |
|---|---|
| The sandbox images, built on the machine from the copy | `vha-browse`, `vha-probe`, `vha-engine-compute`; the manager runs them by image id (`/etc/vha/images.env`) |
| sandbox-manager and egress-proxy, static binaries built in the pinned Rust container (`Dockerfile.bins`) | `/usr/local/lib/vha/` |
| The sandbox network | Docker network `vha-sbx`: bridge `vha-sbx`, 172.30.78.0/24, container-to-container traffic off |
| The egress proxy | `vha-egress-proxy.service`, as user `vha-egress`, on 172.30.78.1:8201. Control socket `/run/vha-egress/control.sock`, mode 0660, group `vha-ctl` |
| sandbox-manager | `vha-sandbox-manager.service`, as user `vha-sandbox` (groups `docker` and `vha-ctl`), `SANDBOX_BACKEND=gvisor`, Chromium's own sandbox on, API on 127.0.0.1:8200 |
| The caller token for runner | `/etc/vha/runner-token` (root only); its sha256 is in `SANDBOX_MANAGER_CALLERS` |
| The firewall | `deploy/nftables/sandbox.nft` in `/etc/vha/nft/`, with this machine's values in `/etc/vha/nft/sandbox-vars.nft`; `vha-nft.service` loads it at boot |
| Test tools (`--with-tests`) | Node (pinned tarball, checked by sha256) in `/opt/vha/node`, and `npm ci` in the copy |

The `docker` group can run any container, so `vha-sandbox` is as strong as root on this machine. That is why it is a
separate user that never connects out (the firewall drops its outbound packets), and why the proxy, which does connect
out, is a different user with no Docker access.

### The firewall, and the rollback

`setup.sh` loads the table live, in one transaction with the old inet tables out, and arms a timer that puts the old
tables back after `--rollback-seconds` (300). It also turns ufw off: a packet must pass every table, and ufw's default
"deny incoming" would drop the sandboxes' packets to the proxy (the rollback turns ufw back on). Run `vha-nft-confirm` from a new ssh connection: if it runs, SSH still
works, so it cancels the rollback and enables the table at boot. A mistake can't lock SSH out for longer than the timer.

What the table does (comments in the file):

- Sandboxes, on any `vha-sbx*` bridge: the proxy's port on the host, nothing else. No forwarding, no DNS.
- The proxy's user: replies to its sandboxes; out on 443 only; never to 10/8, 172.16/12, 192.168/16, 127/8,
  169.254/16 (the metadata address), 100.64/10 or the other special ranges; DNS (on Vultr, resolv.conf names Vultr's public resolvers, not a 127.0.0.53 stub).
- The manager's user: loopback, and replies on the VPC interface. Nothing it starts leaves the host.
- SSH only from the admin address.

## `make containment`

On the machine, as root, after `setup.sh --with-tests`:

```sh
cd /opt/vha/src/current && deploy/sandbox-host/run-containment.sh
```

It runs `sandbox/test/containment.test.ts` with `SANDBOX_TOPOLOGY=host`: the installed binaries, the images by id, a test
bridge `vha-sbx-t` under the same firewall, the proxy on the host as `vha-egress` (a transient systemd unit with the dev
fixture map), and the fixture site on 127.0.0.1 (let through by one element of the table's `dev_fixtures` set, removed
after the run). The test manager runs as root. The output and the scoreboard go to `containment-out/` (`scoreboard.md`,
`score.json`, `vitest.json`).

`deploy/sandbox-host/run-containment.sh` runs it that way (the installed binaries, the images from `/etc/vha/images.env`)
and adds the firewall's drop counters to `containment-out/run.log`.

## Not done here (the deploy)

- The VPC: until it is attached, the manager listens on 127.0.0.1:8200 and the firewall's VPC values are placeholders
  (`VPC_IF=none`). The deploy runs `setup.sh` again with `--vpc-if <if> --control-vpc-ip <control's VPC address>
  --vpc-subnet <cidr>` and sets `SANDBOX_MANAGER_ADDR` in `/etc/vha/sandbox-manager.env` to this machine's VPC address.
- runner on the control VM needs `/etc/vha/runner-token` as its sandbox-manager token.
- `deploy/compose.sandbox.yml` and `deploy/images/sandbox-host.Dockerfile` (the paused deploy WIP) run the same two
  binaries in host-network containers that share uid 10002. That is not what was tested here: here the proxy and the
  manager are two users, and only the proxy's user may connect out. The deploy uses one of the two ways, not both.
