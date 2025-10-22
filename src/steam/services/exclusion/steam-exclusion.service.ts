import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { SteamExcludedRegistry } from '../../entities/steam-excluded-registry.entity';

export type SteamExclusionReason =
  | 'NON_GAME'
  | 'NO_DETAILS'
  | 'REQUEST_FAILED'
  | 'MANUAL';

const EXCLUSION_REASONS: SteamExclusionReason[] = [
  'NON_GAME',
  'NO_DETAILS',
  'REQUEST_FAILED',
  'MANUAL',
];

const BUCKET_SIZE = 8192;
const BITMAP_BYTES = BUCKET_SIZE / 8;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10분

interface BucketStatsPayload {
  total: number;
  byReason: Record<SteamExclusionReason, number>;
  reasonBitmaps?: Record<SteamExclusionReason, string>;
}

interface DirtyBucketExport {
  bucketId: number;
  bitmap: Buffer;
  stats: Record<string, unknown>;
  empty: boolean;
}

interface ReasonBitmapMap {
  [reason: string]: Uint8Array;
}

interface BucketState {
  bitmap: Uint8Array;
  reasonBitmaps: ReasonBitmapMap;
  total: number;
  byReason: Record<SteamExclusionReason, number>;
  dirty: boolean;
}

export interface BucketStatus {
  bucketId: number;
  total: number;
  byReason: Record<SteamExclusionReason, number>;
  sampleSteamIds: number[];
  sampleTruncated: boolean;
  updatedAt: Date | null;
}

@Injectable()
export class SteamExclusionService {
  private readonly logger = new Logger(SteamExclusionService.name);
  private cache: { bitmap: SteamExclusionBitmap; expiresAt: number } | null =
    null;

  constructor(
    @InjectRepository(SteamExcludedRegistry)
    private readonly exclusionRepository: Repository<SteamExcludedRegistry>,
  ) {}

  /**
   * 제외 비트맵 조회 (캐시)
   */
  async loadBitmap(forceReload = false): Promise<SteamExclusionBitmap> {
    if (!forceReload && this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.bitmap;
    }

    const rows = await this.exclusionRepository.find();
    const bitmap = SteamExclusionBitmap.fromRows(rows);
    this.cache = {
      bitmap,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return bitmap;
  }

  /**
   * 제외 여부 확인
   */
  async has(steamId: number): Promise<boolean> {
    const bitmap = await this.loadBitmap();
    return bitmap.has(steamId);
  }

  /**
   * 제외 ID 전체 조회 (기존 호환용)
   */
  async getExcludedIds(): Promise<Set<number>> {
    const bitmap = await this.loadBitmap();
    return bitmap.collectAsSet();
  }

  async getBucketStatusBySteamId(
    steamId: number,
    sampleLimit = 50,
  ): Promise<BucketStatus> {
    const bucketId = Math.floor(steamId / BUCKET_SIZE);
    return this.getBucketStatus(bucketId, sampleLimit);
  }

  async getBucketStatus(
    bucketId: number,
    sampleLimit = 50,
  ): Promise<BucketStatus> {
    const bitmap = await this.loadBitmap();
    const snapshot = bitmap.getBucketSnapshot(bucketId, sampleLimit);
    const row = await this.exclusionRepository.findOne({
      where: { bucket_id: bucketId },
    });

    const counts = snapshot?.byReason ?? buildEmptyReasonCounts();

    return {
      bucketId,
      total: snapshot?.total ?? 0,
      byReason: counts,
      sampleSteamIds: snapshot?.steamIds ?? [],
      sampleTruncated: snapshot?.truncated ?? false,
      updatedAt: row?.last_updated_at ?? null,
    };
  }

  /**
   * 신규 제외 등록
   */
  async markExcluded(
    steamId: number,
    reason: SteamExclusionReason,
  ): Promise<boolean> {
    const bitmap = await this.loadBitmap();
    const changed = bitmap.mark(steamId, reason);
    if (!changed) {
      return false;
    }

    await this.persistDirtyBuckets(bitmap);
    return true;
  }

  /**
   * 제외 복구
   */
  async clear(steamId: number): Promise<boolean> {
    const bitmap = await this.loadBitmap();
    const changed = bitmap.clear(steamId);
    if (!changed) {
      return false;
    }

    await this.persistDirtyBuckets(bitmap);
    return true;
  }

  /**
   * 캐시 무효화
   */
  async invalidateCache(): Promise<void> {
    this.cache = null;
  }

  /**
   * 버킷 저장
   */
  private async persistDirtyBuckets(
    bitmap: SteamExclusionBitmap,
  ): Promise<void> {
    const dirtyBuckets = bitmap.takeDirtyBuckets();
    if (dirtyBuckets.length === 0) {
      return;
    }

    await this.exclusionRepository.manager.transaction(
      async (manager: EntityManager) => {
        for (const bucket of dirtyBuckets) {
          if (bucket.empty) {
            await manager.delete(SteamExcludedRegistry, {
              bucket_id: bucket.bucketId,
            });
            continue;
          }

          await manager.getRepository(SteamExcludedRegistry).upsert(
            {
              bucket_id: bucket.bucketId,
              bitmap: bucket.bitmap,
              stats: bucket.stats,
              last_updated_at: new Date(),
            },
            ['bucket_id'],
          );
        }
      },
    );

    if (this.cache) {
      this.cache.expiresAt = Date.now() + CACHE_TTL_MS;
    }
  }
}

class SteamExclusionBitmap {
  private readonly buckets = new Map<number, BucketState>();
  private readonly dirtyBucketIds = new Set<number>();

  static fromRows(rows: SteamExcludedRegistry[]): SteamExclusionBitmap {
    const bitmap = new SteamExclusionBitmap();

    rows.forEach((row) => {
      const bucketId = Number(row.bucket_id);
      const bitmapBytes = toUint8Array(row.bitmap);
      const payload = normalizeStatsPayload(row.stats);

      const reasonBitmaps: ReasonBitmapMap = {};
      EXCLUSION_REASONS.forEach((reason) => {
        const base64 = payload.reasonBitmaps?.[reason];
        reasonBitmaps[reason] = base64
          ? toUint8Array(Buffer.from(base64, 'base64'))
          : createEmptyBitmap();
      });

      bitmap.buckets.set(bucketId, {
        bitmap: cloneBitmap(bitmapBytes),
        reasonBitmaps,
        total: payload.total,
        byReason: { ...payload.byReason },
        dirty: false,
      });
    });

    return bitmap;
  }

  has(steamId: number): boolean {
    const { bucket, offset } = this.ensureBucket(steamId, false);
    if (!bucket) return false;

    return isBitSet(bucket.bitmap, offset);
  }

  mark(steamId: number, reason: SteamExclusionReason): boolean {
    const { bucket, bucketId, offset } = this.ensureBucket(steamId, true);
    if (!bucket) return false;

    const wasSet = isBitSet(bucket.bitmap, offset);
    const prevReason = this.findReason(bucket, offset);

    if (wasSet && prevReason === reason) {
      return false;
    }

    // 기존 비트 해제 및 카운트 조정
    if (wasSet && prevReason) {
      clearBit(bucket.bitmap, offset);
      const prevBitmap = bucket.reasonBitmaps[prevReason];
      clearBit(prevBitmap, offset);
      bucket.byReason[prevReason] = Math.max(
        0,
        (bucket.byReason[prevReason] ?? 0) - 1,
      );
      bucket.total = Math.max(0, bucket.total - 1);
    }

    // 신규 비트 세팅
    setBit(bucket.bitmap, offset);
    const reasonBitmap = bucket.reasonBitmaps[reason];
    setBit(reasonBitmap, offset);
    bucket.byReason[reason] = (bucket.byReason[reason] ?? 0) + 1;
    bucket.total += 1;

    this.markDirty(bucketId, bucket);
    return true;
  }

  clear(steamId: number): boolean {
    const { bucket, bucketId, offset } = this.ensureBucket(steamId, false);
    if (!bucket) return false;

    if (!isBitSet(bucket.bitmap, offset)) {
      return false;
    }

    clearBit(bucket.bitmap, offset);

    const reason = this.findReason(bucket, offset);
    if (reason) {
      clearBit(bucket.reasonBitmaps[reason], offset);
      bucket.byReason[reason] = Math.max(0, (bucket.byReason[reason] ?? 0) - 1);
    }

    bucket.total = Math.max(0, bucket.total - 1);
    this.markDirty(bucketId, bucket);
    return true;
  }

  collectAsSet(): Set<number> {
    const ids = new Set<number>();
    this.buckets.forEach((bucket, bucketId) => {
      for (let offset = 0; offset < BUCKET_SIZE; offset += 1) {
        if (isBitSet(bucket.bitmap, offset)) {
          ids.add(bucketId * BUCKET_SIZE + offset);
        }
      }
    });
    return ids;
  }

  takeDirtyBuckets(): DirtyBucketExport[] {
    const exports: DirtyBucketExport[] = [];

    this.dirtyBucketIds.forEach((bucketId) => {
      const bucket = this.buckets.get(bucketId);
      if (!bucket) return;

      const empty = bucket.total === 0;
      const payload: BucketStatsPayload = {
        total: bucket.total,
        byReason: { ...bucket.byReason },
        reasonBitmaps: buildReasonBitmapPayload(bucket.reasonBitmaps),
      };

      exports.push({
        bucketId,
        bitmap: Buffer.from(bucket.bitmap),
        stats: statsPayloadToRecord(payload),
        empty,
      });

      bucket.dirty = false;
    });

    this.dirtyBucketIds.clear();
    return exports;
  }

  getBucketSnapshot(
    bucketId: number,
    sampleLimit = 50,
  ): {
    bucketId: number;
    total: number;
    byReason: Record<SteamExclusionReason, number>;
    steamIds: number[];
    truncated: boolean;
  } | null {
    const bucket = this.buckets.get(bucketId);
    if (!bucket) return null;

    const sample: number[] = [];
    let truncated = false;

    for (let offset = 0; offset < BUCKET_SIZE; offset += 1) {
      if (isBitSet(bucket.bitmap, offset)) {
        const steamId = bucketId * BUCKET_SIZE + offset;
        if (sample.length < sampleLimit) {
          sample.push(steamId);
        } else {
          truncated = true;
        }
      }
    }

    return {
      bucketId,
      total: bucket.total,
      byReason: { ...bucket.byReason },
      steamIds: sample,
      truncated,
    };
  }

  private ensureBucket(
    steamId: number,
    createIfMissing: boolean,
  ): { bucket: BucketState | undefined; bucketId: number; offset: number } {
    const bucketId = Math.floor(steamId / BUCKET_SIZE);
    const offset = steamId % BUCKET_SIZE;
    let bucket = this.buckets.get(bucketId);

    if (!bucket && createIfMissing) {
      const reasonBitmaps: ReasonBitmapMap = {};
      EXCLUSION_REASONS.forEach((reason) => {
        reasonBitmaps[reason] = createEmptyBitmap();
      });

      bucket = {
        bitmap: createEmptyBitmap(),
        reasonBitmaps,
        total: 0,
        byReason: buildEmptyReasonCounts(),
        dirty: false,
      };
      this.buckets.set(bucketId, bucket);
    }

    return { bucket, bucketId, offset };
  }

  private findReason(
    bucket: BucketState,
    offset: number,
  ): SteamExclusionReason | null {
    for (const reason of EXCLUSION_REASONS) {
      const bitmap = bucket.reasonBitmaps[reason];
      if (bitmap && isBitSet(bitmap, offset)) {
        return reason;
      }
    }
    return null;
  }

  private markDirty(bucketId: number, bucket: BucketState): void {
    bucket.dirty = true;
    this.dirtyBucketIds.add(bucketId);
  }
}

function setBit(bitmap: Uint8Array, offset: number): void {
  const byteIndex = offset >> 3;
  const mask = 1 << (offset & 7);
  bitmap[byteIndex] |= mask;
}

function clearBit(bitmap: Uint8Array, offset: number): void {
  const byteIndex = offset >> 3;
  const mask = ~(1 << (offset & 7));
  bitmap[byteIndex] &= mask;
}

function isBitSet(bitmap: Uint8Array, offset: number): boolean {
  const byteIndex = offset >> 3;
  const mask = 1 << (offset & 7);
  return (bitmap[byteIndex] & mask) !== 0;
}

function createEmptyBitmap(): Uint8Array {
  return new Uint8Array(BITMAP_BYTES);
}

function cloneBitmap(bitmap: Uint8Array): Uint8Array {
  const clone = new Uint8Array(bitmap.length);
  clone.set(bitmap);
  return clone;
}

function buildEmptyReasonCounts(): Record<SteamExclusionReason, number> {
  const counts: Record<SteamExclusionReason, number> = {
    NON_GAME: 0,
    NO_DETAILS: 0,
    REQUEST_FAILED: 0,
    MANUAL: 0,
  };
  return counts;
}

function toUint8Array(buffer: Buffer | Uint8Array): Uint8Array {
  if (buffer instanceof Uint8Array && !(buffer instanceof Buffer)) {
    return new Uint8Array(buffer);
  }
  return new Uint8Array(buffer);
}

function normalizeStatsPayload(stats: unknown): BucketStatsPayload {
  const payload =
    typeof stats === 'object' && stats !== null
      ? (stats as Partial<BucketStatsPayload>)
      : {};
  return {
    total: typeof payload.total === 'number' ? payload.total : 0,
    byReason: {
      NON_GAME: payload.byReason?.NON_GAME ?? 0,
      NO_DETAILS: payload.byReason?.NO_DETAILS ?? 0,
      REQUEST_FAILED: payload.byReason?.REQUEST_FAILED ?? 0,
      MANUAL: payload.byReason?.MANUAL ?? 0,
    },
    reasonBitmaps: normalizeReasonBitmaps(payload.reasonBitmaps),
  };
}

function buildReasonBitmapPayload(
  bitmaps: ReasonBitmapMap,
): Record<SteamExclusionReason, string> {
  const payload: Record<SteamExclusionReason, string> = {
    NON_GAME: '',
    NO_DETAILS: '',
    REQUEST_FAILED: '',
    MANUAL: '',
  };

  EXCLUSION_REASONS.forEach((reason) => {
    const bitmap = bitmaps[reason] ?? createEmptyBitmap();
    payload[reason] = Buffer.from(bitmap).toString('base64');
  });

  return payload;
}

function normalizeReasonBitmaps(
  bitmaps?: Record<SteamExclusionReason, string>,
): Record<SteamExclusionReason, string> {
  const normalized: Record<SteamExclusionReason, string> = {
    NON_GAME: '',
    NO_DETAILS: '',
    REQUEST_FAILED: '',
    MANUAL: '',
  };

  EXCLUSION_REASONS.forEach((reason) => {
    const base64 = bitmaps?.[reason];
    normalized[reason] =
      typeof base64 === 'string' && base64.length > 0 ? base64 : '';
  });

  return normalized;
}

function statsPayloadToRecord(
  payload: BucketStatsPayload,
): Record<string, unknown> {
  return {
    total: payload.total,
    byReason: payload.byReason,
    reasonBitmaps: payload.reasonBitmaps,
  };
}
