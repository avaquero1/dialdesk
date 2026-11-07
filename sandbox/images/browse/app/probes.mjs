/* global process, setTimeout, clearTimeout, Buffer */
// Attack probes for the containment tests (the `probe` image only, never the browse image). Each one runs in a
// fresh sandbox made with exactly a browse job's flags, prints one JSON line, and is judged from outside.
//   whoami | secrets CANARY | memhog | forkbomb | spin | net PROXY_HOST PROXY_PORT | marker-write TOKEN | marker-find TOKEN
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [cmd, ...rest] = process.argv.slice(2);
const out = (o) => fs.writeSync(1, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusField = (k) => fs.readFileSync('/proc/self/status', 'utf8').match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1];
const pids = () => fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x));

function files(roots, { maxFiles = 50000, budgetMs = 15000 } = {}) {
  const list = [];
  const stack = [...roots];
  const t0 = Date.now();
  while (stack.length && list.length < maxFiles && Date.now() - t0 < budgetMs) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) list.push(p);
    }
  }
  return list;
}

function head(p, n = 65536) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(n);
    const k = fs.readSync(fd, b, 0, n, 0);
    fs.closeSync(fd);
    return b.toString('latin1', 0, k);
  } catch {
    return '';
  }
}

function tryConnect(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeout, () => done('timeout'));
    s.once('connect', () => done('connected'));
    s.once('error', (e) => done(e.code || e.message));
  });
}

function udpDns(server, timeout = 2000) {
  const q = Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001', 'hex'); // A example.com
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => (s.close(), resolve('no-answer')), timeout);
    s.once('message', () => (clearTimeout(t), s.close(), resolve('answered')));
    s.once('error', (e) => (clearTimeout(t), s.close(), resolve(e.code || e.message)));
    s.send(q, 53, server);
  });
}

switch (cmd) {
  case 'whoami': {
    const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map((l) => {
      const [pre, post] = l.split(' - ');
      return { mp: pre.split(' ')[4], fstype: post.split(' ')[0] };
    });
    // What Docker itself puts in every container, read only: resolv.conf (ours: empty), hostname, hosts, and
    // docker-init from --init. Any other disk mount would be a host folder.
    const std = new Set(['/', '/etc/resolv.conf', '/etc/hostname', '/etc/hosts', '/sbin/docker-init', '/usr/sbin/docker-init']);
    const disk = /^(ext[234]|xfs|btrfs|zfs|virtiofs|9p|fuse.*|nfs.*|vfat)$/;
    const hostMounts = mounts.filter((m) => !std.has(m.mp) && disk.test(m.fstype)).map((m) => `${m.mp} (${m.fstype})`);
    let writableRoot = false;
    try {
      fs.writeFileSync('/probe-rw', 'x');
      writableRoot = true;
    } catch {
      /* read-only, as it should be */
    }
    const setuid = files(['/usr', '/bin', '/sbin']).filter((p) => {
      try {
        return (fs.statSync(p).mode & 0o6000) !== 0;
      } catch {
        return false;
      }
    });
    out({
      uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
      capEff: statusField('CapEff'), capBnd: statusField('CapBnd'), noNewPrivs: statusField('NoNewPrivs'),
      dockerSock: ['/var/run/docker.sock', '/run/docker.sock'].filter((p) => fs.existsSync(p)),
      hostMounts, writableRoot, setuid,
    });
    break;
  }
  case 'secrets': {
    // The canary is planted on the host (the manager's env and a file beside it); it must not be in here.
    const canary = rest[0] || 'no-canary';
    const valRe = new RegExp(`${canary}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}`);
    const nameRe = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE)/i;
    const hits = [];
    const envNames = new Set();
    let procs = 0;
    for (const d of pids()) {
      let env;
      try {
        env = fs.readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').filter(Boolean);
      } catch {
        continue;
      }
      procs++;
      for (const kv of env) {
        const name = kv.slice(0, kv.indexOf('='));
        envNames.add(name);
        // The probe's own command line holds the canary, its environment must not.
        if (valRe.test(kv) || nameRe.test(name)) hits.push(`env pid ${d}: ${name}`);
      }
    }
    const list = files(['/etc', '/home', '/tmp', '/app', '/var', '/root', '/run', '/opt', '/srv', '/mnt']).filter(
      (p) => !p.startsWith('/app/node_modules/') && p !== '/app/probes.mjs',
    );
    for (const p of list) {
      if (/(^|\/)(\.env|id_rsa|id_ed25519|\.netrc|\.npmrc|\.git-credentials|credentials)$/.test(p)) hits.push(`file name: ${p}`);
      else if (valRe.test(head(p))) hits.push(`file content: ${p}`);
    }
    out({ hits, procs, filesScanned: list.length, envNames: [...envNames].sort() });
    break;
  }
  case 'memhog': {
    const keep = [];
    for (let mb = 32; ; mb += 32) {
      const b = Buffer.alloc(32 * 1024 * 1024);
      b.fill(1);
      keep.push(b);
      out({ allocatedMb: mb });
    }
  }
  case 'spin':
    out({ spinning: true });
    for (;;) {
      /* burn CPU until the time cap ends the sandbox */
    }
  case 'forkbomb': {
    // Bounded on purpose: up to 2000 sleeping children. The process cap must stop it well before that.
    const kids = [];
    let refused = 0;
    let firstError = null;
    for (let i = 0; i < 2000; i++) {
      try {
        const c = spawn('sleep', ['30'], { stdio: 'ignore' });
        c.on('error', (e) => {
          refused++;
          firstError ??= e.code || e.message;
        });
        kids.push(c);
      } catch (e) {
        refused++;
        firstError ??= e.code || e.message;
      }
      if (i % 50 === 0) await sleep(5);
    }
    await sleep(1500);
    const peak = pids().length;
    for (const c of kids) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* never started */
      }
    }
    out({ tried: 2000, peakProcesses: peak, refused, firstError });
    break;
  }
  case 'net': {
    const [proxyHost, proxyPort] = rest;
    const targets = {
      public_ip: ['1.1.1.1', 443],
      public_dns_tcp: ['8.8.8.8', 53],
      metadata: ['169.254.169.254', 80],
      private_10: ['10.0.0.1', 80],
      private_192: ['192.168.1.1', 80],
      proxy_other_port: [proxyHost, 22],
      proxy_port: [proxyHost, Number(proxyPort)],
    };
    const results = {};
    for (const [k, [h, p]] of Object.entries(targets)) results[k] = await tryConnect(h, p);
    const resolver = await dns.lookup('example.com').then((r) => `resolved ${r.address}`).catch((e) => e.code || e.message);
    out({
      results, resolver,
      resolvConf: fs.readFileSync('/etc/resolv.conf', 'utf8').trim(),
      udp53: { '1.1.1.1': await udpDns('1.1.1.1'), '8.8.8.8': await udpDns('8.8.8.8') },
    });
    break;
  }
  case 'marker-write': {
    const token = rest[0];
    const wrote = [];
    for (const p of [`/tmp/marker-${token}`, `/home/sbx/marker-${token}`, `/dev/shm/marker-${token}`, `/var/tmp/marker-${token}`, `/app/marker-${token}`]) {
      try {
        fs.writeFileSync(p, token);
        wrote.push(p);
      } catch {
        /* read-only here */
      }
    }
    out({ wrote });
    break;
  }
  case 'marker-find': {
    const token = rest[0];
    const found = files(['/tmp', '/home', '/dev/shm', '/var', '/app', '/run', '/etc', '/root']).filter((p) => p.includes(token));
    out({ found });
    break;
  }
  default:
    out({ error: `unknown probe ${cmd}` });
    process.exit(2);
}
