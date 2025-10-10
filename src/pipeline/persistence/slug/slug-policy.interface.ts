import { EntityManager } from 'typeorm';

export interface SlugContext {
  selfId: number | null;
  name: string;
  ogName?: string | null;
  preferredSlug?: string | null;
  preferredOgSlug?: string | null;
  fallbackSteamId?: number | null;
  fallbackRawgId?: number | null;
}

export interface ResolvedSlug {
  slug: string;
  ogSlug: string;
}

export interface SlugPolicyPort {
  resolve(manager: EntityManager, context: SlugContext): Promise<ResolvedSlug>;
}

export const SLUG_POLICY = Symbol('SLUG_POLICY_PORT');
