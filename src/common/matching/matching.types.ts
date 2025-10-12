import { CompanyData } from '@pipeline/contracts';

/**
 * 이름 정규화 결과 구조
 */
export interface NormalizedNameResult {
  original: string;
  lowercase: string;
  tokens: string[];
  looseSlug: string;
  compact: string;
}

export interface MatchingWeights {
  name: number;
  releaseDate: number;
  company: number;
  genre: number;
  bonus: number;
}

export interface MatchingInputs {
  rawgName: NormalizedNameResult;
  steamName: NormalizedNameResult;
  rawgReleaseDate?: Date | null;
  steamReleaseDate?: Date | null;
  rawgCompanies?: CompanyData[];
  steamCompanies?: CompanyData[];
  rawgGenres?: string[];
  steamGenres?: string[];
  pcReleaseAligned?: boolean;
  weights?: Partial<MatchingWeights>;
}

export interface MatchingBreakdown {
  nameScore: number;
  releaseDateScore: number;
  companyScore: number;
  genreScore: number;
  bonusScore: number;
}

export interface MatchingScore {
  totalScore: number;
  breakdown: MatchingBreakdown;
  flags: {
    nameExactMatch: boolean;
    slugMatch: boolean;
    releaseDateDiffDays: number | null;
    companyOverlap: string[];
    genreOverlap: string[];
  };
}
