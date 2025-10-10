import { IsEnum, IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';

export enum IdKindEnum {
  game = 'game',
  steam = 'steam',
  rawg = 'rawg',
}
export enum SourcesEnum {
  steam = 'steam',
  rawg = 'rawg',
  both = 'both',
}
export enum ModeEnum {
  bootstrap = 'bootstrap',
  operational = 'operational',
}

export class SingleGameManualDto {
  @IsOptional()
  @IsEnum(IdKindEnum)
  idKind?: IdKindEnum;

  @IsOptional()
  @IsEnum(SourcesEnum)
  sources?: SourcesEnum;

  @IsOptional()
  @IsEnum(ModeEnum)
  mode?: ModeEnum;

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true' || value === '1';
    if (typeof value === 'number') return value === 1;
    return false;
  })
  @IsBoolean()
  dryRun?: boolean;
}
