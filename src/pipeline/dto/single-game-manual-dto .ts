import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class SingleGameManualDto {
  @IsOptional()
  @IsEnum(['steam', 'rawg', 'both'] as const)
  sources?: 'steam' | 'rawg' | 'both';

  @IsOptional()
  @IsEnum(['bootstrap', 'operational'] as const)
  mode?: 'bootstrap' | 'operational';

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  dryRun?: boolean;
}