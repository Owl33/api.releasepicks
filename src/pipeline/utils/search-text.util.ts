import { CompanyData } from '../types/pipeline.types';
import { CompanyRole } from '../../entities/enums';

/**
 * 게임 이름과 회사 정보를 기반으로 검색 텍스트를 생성한다.
 * 게임명 + 개발사 + 퍼블리셔를 공백 한 칸으로 이어 붙여 Supabase PGroonga 검색용으로 저장한다.
 */
export function buildSearchText(
  gameName: string,
  companies?: CompanyData[],
): string {
  const tokens: string[] = [];

  if (gameName?.trim()) {
    tokens.push(gameName.trim());
  }

  if (companies && companies.length > 0) {
    for (const company of companies) {
      const name = company?.name?.trim();
      if (!name) {
        continue;
      }

      if (company.role === CompanyRole.DEVELOPER) {
        tokens.push(name);
        continue;
      }

      if (company.role === CompanyRole.PUBLISHER) {
        tokens.push(name);
      }
    }
  }

  // 중복 제거 및 소문자 통일, 다중 공백 제거
  const normalized = Array.from(new Set(tokens.map((token) => token.toLowerCase())));
  return normalized.join(' ').replace(/\s+/g, ' ').trim();
}
