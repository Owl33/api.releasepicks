import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

interface SteamExcludedAppRow {
  steam_id: number;
  reason: string;
  excluded_at: Date;
  last_attempt_at: Date | null;
  attempts: number;
  note: string | null;
}

@Injectable()
export class SteamExclusionService {
  constructor(
    @InjectRepository('steam_excluded_apps', 'default')
    private readonly exclusionRepository: Repository<SteamExcludedAppRow>,
  ) {}

  async getExcludedIds(): Promise<Set<number>> {
    const rows = await this.exclusionRepository.find({
      select: ['steam_id'],
    });
    return new Set(rows.map((row) => Number(row.steam_id)));
  }

  async markExcluded(
    steamId: number,
    reason: string,
    note?: string,
  ): Promise<void> {
    await this.exclusionRepository
      .createQueryBuilder()
      .insert()
      .into('steam_excluded_apps')
      .values({
        steam_id: steamId,
        reason,
        note: note ?? null,
      })
      .onConflict(`(steam_id) DO UPDATE SET reason = EXCLUDED.reason, attempts = steam_excluded_apps.attempts + 1, last_attempt_at = NOW(), note = EXCLUDED.note`)
      .execute();
  }

  async markRetry(steamId: number): Promise<void> {
    await this.exclusionRepository
      .createQueryBuilder()
      .update('steam_excluded_apps')
      .set({
        last_attempt_at: () => 'NOW()',
      })
      .where('steam_id = :steamId', { steamId })
      .execute();
  }

  async remove(steamId: number): Promise<void> {
    await this.exclusionRepository.delete({ steam_id: steamId });
  }
}
