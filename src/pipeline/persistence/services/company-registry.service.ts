import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, ILike } from 'typeorm';

import { CompanyData } from '@pipeline/contracts';

import { Company } from '../../../entities/company.entity';
import { GameCompanyRole } from '../../../entities/game-company-role.entity';

/**
 * CompanyRegistryService
 * - 회사 엔티티 및 역할 연결을 관리
 */
@Injectable()
export class CompanyRegistryService {
  private readonly logger = new Logger(CompanyRegistryService.name);

  async syncCompanies(
    gameId: number,
    companies: CompanyData[],
    manager: EntityManager,
  ): Promise<void> {
    for (const companyData of companies) {
      const nameTrimmed = companyData.name.trim();
      const baseSlug = (
        companyData.slug ?? this.generateCompanySlug(companyData.name)
      )
        .trim()
        .toLowerCase();

      let company = await manager.findOne(Company, {
        where: { slug: baseSlug },
      });

      if (!company) {
        company = await manager.findOne(Company, {
          where: { name: ILike(nameTrimmed) },
        });
      }

      if (!company) {
        let candidateSlug = baseSlug;
        let suffix = 2;
        while (true) {
          const exists = await manager.findOne(Company, {
            where: { slug: candidateSlug },
          });
          if (!exists) break;
          candidateSlug = `${baseSlug}-${suffix++}`;
        }

        const insertResult = await manager
          .createQueryBuilder()
          .insert()
          .into(Company)
          .values({
            name: nameTrimmed,
            slug: candidateSlug,
          })
          .onConflict('DO NOTHING')
          .returning(['id', 'name', 'slug', 'created_at', 'updated_at'])
          .execute();

        const rawRows = Array.isArray(insertResult.raw)
          ? (insertResult.raw as Array<Partial<Company>>)
          : [];

        if (rawRows.length > 0 && rawRows[0].id) {
          company = manager.create(Company, rawRows[0]);
        } else {
          company = await manager.findOne(Company, {
            where: { slug: candidateSlug },
          });
        }
      }

      if (!company) {
        this.logger.warn(
          `회사 생성에 실패했습니다: name=${nameTrimmed}, baseSlug=${baseSlug}`,
        );
        continue;
      }

      const existingRole = await manager.findOne(GameCompanyRole, {
        where: {
          game_id: gameId,
          company_id: company.id,
          role: companyData.role,
        },
      });

      if (!existingRole) {
        const role = manager.create(GameCompanyRole, {
          game_id: gameId,
          company_id: company.id,
          role: companyData.role,
        });
        await manager.save(GameCompanyRole, role);
      }
    }
  }

  private generateCompanySlug(name: string): string {
    if (!name || typeof name !== 'string') {
      this.logger.warn(
        `회사 슬러그 생성 실패: 잘못된 name 타입=${typeof name}, value=${JSON.stringify(name)}`,
      );
      return 'unknown-company';
    }

    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9가-힣\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 100) || 'unknown-company'
    );
  }
}
