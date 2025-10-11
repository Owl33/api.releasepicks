import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { SteamExclusionService } from './services/exclusion/steam-exclusion.service';
import {
  BucketSnapshotQueryDto,
  ClearSteamExclusionDto,
  MarkSteamExclusionDto,
} from './dto/admin-steam-exclusion.dto';
import { ServiceRoleGuard } from '../common/guards/service-role.guard';

@Controller('api/admin/steam-exclusions')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@UseGuards(ServiceRoleGuard)
export class AdminSteamExclusionController {
  constructor(private readonly steamExclusionService: SteamExclusionService) {}

  @Post('mark')
  async mark(@Body() dto: MarkSteamExclusionDto) {
    const changed = await this.steamExclusionService.markExcluded(
      dto.steamId,
      dto.reason,
    );
    const bucket = await this.steamExclusionService.getBucketStatusBySteamId(
      dto.steamId,
    );

    return {
      statusCode: 200,
      message: changed ? 'marked' : 'already-marked',
      data: {
        changed,
        bucket,
      },
    };
  }

  @Post('clear')
  async clear(@Body() dto: ClearSteamExclusionDto) {
    const changed = await this.steamExclusionService.clear(dto.steamId);
    const bucket = await this.steamExclusionService.getBucketStatusBySteamId(
      dto.steamId,
    );

    return {
      statusCode: 200,
      message: changed ? 'cleared' : 'not-found',
      data: {
        changed,
        bucket,
      },
    };
  }

  @Get('bucket/:bucketId')
  async getBucket(
    @Param('bucketId', ParseIntPipe) bucketId: number,
    @Query() query: BucketSnapshotQueryDto,
  ) {
    const limit = query.sampleLimit ?? 50;
    const bucket = await this.steamExclusionService.getBucketStatus(
      bucketId,
      limit,
    );

    return {
      statusCode: 200,
      message: 'ok',
      data: bucket,
    };
  }

  @Get('steam/:steamId')
  async getBySteamId(
    @Param('steamId', ParseIntPipe) steamId: number,
    @Query() query: BucketSnapshotQueryDto,
  ) {
    const limit = query.sampleLimit ?? 50;
    const bucket = await this.steamExclusionService.getBucketStatusBySteamId(
      steamId,
      limit,
    );

    return {
      statusCode: 200,
      message: 'ok',
      data: bucket,
    };
  }
}
