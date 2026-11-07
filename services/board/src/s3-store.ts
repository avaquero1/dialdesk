/**
 * Screenshots in Vultr Object Storage (S3 API), behind board's ObjectStore. Chosen when BOARD_S3_BUCKET is set;
 * otherwise board keeps the local folder. The bucket is private: edge serves screenshots through board's
 * getScreenshot, so no bucket address goes to the browser.
 */
import { S3Client, s3FromConfig } from '@app/service-kit';
import { checkKey, type ObjectStore } from './storage.ts';

export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3';
  constructor(private readonly s3: S3Client) {}
  async put(key: string, bytes: Buffer, contentType: string) {
    await this.s3.put(checkKey(key), bytes, { contentType });
  }
  async get(key: string) {
    return this.s3.get(checkKey(key));
  }
}

/** S3 when BOARD_S3_BUCKET (plus _ENDPOINT, _REGION, _CREDENTIALS_FILE) is set, else null. */
export function s3ObjectStoreFromConfig(cfg: Record<string, unknown>): S3ObjectStore | null {
  const s3 = s3FromConfig(cfg);
  return s3 ? new S3ObjectStore(s3) : null;
}
