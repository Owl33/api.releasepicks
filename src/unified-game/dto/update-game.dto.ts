import { ReleaseStatus } from '../../types/domain.types';

export interface StoreLinksDto {
  steam?: string;
  playstation?: string;
  xbox?: string;
  nintendo?: string;
  epic?: string;
  gog?: string;
}

export interface UpdateGameDto {
  release_date?: string | null;
  release_status?: ReleaseStatus;
  price?: string | null;
  steam_review_score?: string | null;
  tags?: string[];
  store_links?: StoreLinksDto;
}
