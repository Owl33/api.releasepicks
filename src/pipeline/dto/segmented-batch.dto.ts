import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class SegmentedBatchDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(150000)
  totalLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  chunkSize?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  pauseSeconds?: number;
}
