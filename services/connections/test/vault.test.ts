/** The sealed box (browser → connections) and the vault (at rest): round trips, and every way they must not open. */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { b64, open, seal, sealAad, SealError, sealKeyPair, unb64 } from '../src/seal.ts';
import { openVault, readMasterKey } from '../src/vault.ts';

const PEM = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPLACEHOLDERnotarealkeyatall000000000\n-----END PRIVATE KEY-----\n';
const ACC = 'acc_test0001';
const KID = 'a1b2c3d4-0000-4000-8000-00000000read';

describe('the sealed box', () => {
  it('round-trips through the public key the service publishes', async () => {
    const v = await openVault(randomBytes(32));
    const sealed = await seal(v.seal.publicKeyB64, PEM, sealAad(ACC, KID));
    expect(sealed).not.toContain('PRIVATE');
    expect(await open(v.seal, sealed, sealAad(ACC, KID))).toBe(PEM);
  });

  it('each seal is different (fresh ephemeral key and IV)', async () => {
    const v = await openVault(randomBytes(32));
    const a = await seal(v.seal.publicKeyB64, PEM, sealAad(ACC, KID));
    const b = await seal(v.seal.publicKeyB64, PEM, sealAad(ACC, KID));
    expect(a).not.toBe(b);
  });

  it('does not open for another account or another key id (no replay)', async () => {
    const v = await openVault(randomBytes(32));
    const sealed = await seal(v.seal.publicKeyB64, PEM, sealAad(ACC, KID));
    await expect(open(v.seal, sealed, sealAad('acc_test0002', KID))).rejects.toBeInstanceOf(SealError);
    await expect(open(v.seal, sealed, sealAad(ACC, 'another-key-id'))).rejects.toBeInstanceOf(SealError);
  });

  it('does not open with another master key, or when any byte is changed', async () => {
    const v = await openVault(randomBytes(32));
    const other = await openVault(randomBytes(32));
    const sealed = await seal(v.seal.publicKeyB64, PEM, sealAad(ACC, KID));
    await expect(open(other.seal, sealed, sealAad(ACC, KID))).rejects.toBeInstanceOf(SealError);
    const raw = unb64(sealed);
    for (const i of [0, 1, 20, 33, 40, 45, raw.length - 1]) {
      const t = raw.slice();
      t[i] = t[i]! ^ 0x01;
      await expect(open(v.seal, b64(t), sealAad(ACC, KID)), `byte ${i}`).rejects.toBeInstanceOf(SealError);
    }
    await expect(open(v.seal, b64(raw.subarray(0, 50)), sealAad(ACC, KID))).rejects.toBeInstanceOf(SealError);
    await expect(open(v.seal, '!!!not base64!!!', sealAad(ACC, KID))).rejects.toBeInstanceOf(SealError);
  });

  it('refuses an all-zero (low-order) ephemeral key', async () => {
    const v = await openVault(randomBytes(32));
    const forged = new Uint8Array(1 + 32 + 12 + 32);
    forged[0] = 1;
    await expect(open(v.seal, b64(forged), sealAad(ACC, KID))).rejects.toBeInstanceOf(SealError);
  });

  it('the seal key pair is fixed by the master key', async () => {
    const m = randomBytes(32);
    expect((await openVault(m)).seal.publicKeyB64).toBe((await openVault(Buffer.from(m))).seal.publicKeyB64);
    expect((await openVault(randomBytes(32))).seal.publicKeyB64).not.toBe((await openVault(m)).seal.publicKeyB64);
    expect(unb64((await sealKeyPair(new Uint8Array(32).fill(7))).publicKeyB64)).toHaveLength(32);
  });
});

describe('the vault at rest', () => {
  it('round-trips, bound to the row id; the ciphertext holds no plain text', async () => {
    const m = randomBytes(32);
    const v = await openVault(m);
    const blob = v.encrypt(PEM, 'con_abc12345');
    expect(blob.toString('latin1')).not.toContain('PRIVATE');
    expect((await openVault(Buffer.from(m))).decrypt(blob, 'con_abc12345')).toBe(PEM);
    expect(() => v.decrypt(blob, 'con_other123')).toThrow();
    const t = Buffer.from(blob);
    t[20] = t[20]! ^ 1;
    expect(() => v.decrypt(t, 'con_abc12345')).toThrow();
    const other = await openVault(randomBytes(32));
    expect(() => other.decrypt(blob, 'con_abc12345')).toThrow();
  });
});

describe('the master key file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'connections-master-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('reads 32 bytes of base64 and flags loose permissions', () => {
    const p = join(dir, 'm.key');
    writeFileSync(p, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    expect(readMasterKey(p)).toMatchObject({ looseMode: false });
    chmodSync(p, 0o644);
    expect(readMasterKey(p).looseMode).toBe(true);
  });
  it('refuses a short key and a missing file', () => {
    const p = join(dir, 'short.key');
    writeFileSync(p, randomBytes(16).toString('base64'));
    expect(() => readMasterKey(p)).toThrow(/32 bytes/);
    expect(() => readMasterKey(join(dir, 'missing.key'))).toThrow();
  });
});
