/**
 * Report files and email previews: on S3 when S3_BUCKET is set (every deployed environment), otherwise
 * under DATA_DIR on local disk (tests, or development without a bucket). Keys look like
 * "reports/<assessment id>/report-v2.pdf". Files are versioned, so a regenerated report never
 * overwrites the copy a parent was sent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from './aws';
import { config } from './config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkedId(id: string): string {
  if (!UUID.test(id)) throw new Error(`Refusing to build a storage key for id "${id}"`);
  return id;
}

export type ReportFileKind = 'pdf' | 'chart' | 'snapshot';

export function reportKey(assessmentId: string, version: number, kind: ReportFileKind): string {
  const name = kind === 'pdf' ? `report-v${version}.pdf` : `${kind}-v${version}.png`;
  return `reports/${checkedId(assessmentId)}/${name}`;
}

export function reportPrefix(assessmentId: string): string {
  return `reports/${checkedId(assessmentId)}/`;
}

export function outboxKey(deliveryId: string): string {
  return `outbox/${checkedId(deliveryId)}.eml`;
}

const VALID_KEY = /^(reports\/[0-9a-f-]{36}\/(report-v\d+\.pdf|(chart|snapshot)-v\d+\.png)|outbox\/[0-9a-f-]{36}\.eml)$/;
const VALID_PREFIX = /^reports\/[0-9a-f-]{36}\/$/;

function checkedKey(key: string): string {
  if (!VALID_KEY.test(key)) throw new Error(`Refusing storage key "${key}"`);
  return key;
}

function checkedPrefix(prefix: string): string {
  if (!VALID_PREFIX.test(prefix)) throw new Error(`Refusing storage prefix "${prefix}"`);
  return prefix;
}

export interface FileStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** null when the file doesn't exist. */
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
}

const diskStore: FileStore = {
  async put(key, data) {
    const file = path.join(config.dataDir, checkedKey(key));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  },
  async get(key) {
    try {
      return await fs.readFile(path.join(config.dataDir, checkedKey(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  async remove(key) {
    await fs.rm(path.join(config.dataDir, checkedKey(key)), { force: true });
  },
  async removePrefix(prefix) {
    await fs.rm(path.join(config.dataDir, checkedPrefix(prefix)), { recursive: true, force: true });
  },
};

function s3Store(bucket: string, root: string): FileStore {
  return {
    async put(key, data, contentType) {
      await s3().send(
        new PutObjectCommand({ Bucket: bucket, Key: root + checkedKey(key), Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }),
      );
    },
    async get(key) {
      try {
        const object = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: root + checkedKey(key) }));
        return object.Body ? Buffer.from(await object.Body.transformToByteArray()) : null;
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchKey') return null;
        throw error;
      }
    },
    async remove(key) {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: root + checkedKey(key) }));
    },
    async removePrefix(prefix) {
      let ContinuationToken: string | undefined;
      do {
        const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: root + checkedPrefix(prefix), ContinuationToken }));
        const objects = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []));
        if (objects.length) await s3().send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
        ContinuationToken = page.NextContinuationToken;
      } while (ContinuationToken);
    },
  };
}

export const files: FileStore = config.s3 ? s3Store(config.s3.bucket, config.s3.prefix) : diskStore;
