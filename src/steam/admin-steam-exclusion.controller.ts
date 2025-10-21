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
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('Admin / Steam Exclusions')
@Controller('api/admin/steam-exclusions')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@UseGuards(ServiceRoleGuard)
export class AdminSteamExclusionController {
  constructor(private readonly steamExclusionService: SteamExclusionService) {}

  @Post('mark')
  @ApiOperation({ summary: 'Steam 제외 등록' })
  @ApiBody({ type: MarkSteamExclusionDto })
  @ApiOkResponse({
    description: '제외 등록 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'marked',
        data: { changed: true, bucket: { sample: [] } },
      },
    },
  })
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
  @ApiOperation({ summary: 'Steam 제외 해제' })
  @ApiBody({ type: ClearSteamExclusionDto })
  @ApiOkResponse({
    description: '제외 해제 결과',
    schema: {
      example: {
        statusCode: 200,
        message: 'cleared',
        data: { changed: true, bucket: { sample: [] } },
      },
    },
  })
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
  @ApiOperation({ summary: '버킷 상태 조회' })
  @ApiParam({ name: 'bucketId', description: '버킷 ID', example: 1 })
  @ApiQuery({
    name: 'sampleLimit',
    required: false,
    description: '샘플 개수 (기본 50)',
    schema: { type: 'number', default: 50 },
  })
  @ApiOkResponse({
    description: '버킷 상태',
    schema: {
      example: {
        statusCode: 200,
        message: 'ok',
        data: { bucketId: 1, total: 120, sample: [] },
      },
    },
  })
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
  @ApiOperation({ summary: 'Steam ID 기준 제외 상태 조회' })
  @ApiParam({ name: 'steamId', description: 'Steam AppID', example: 123456 })
  @ApiQuery({
    name: 'sampleLimit',
    required: false,
    description: '샘플 개수 (기본 50)',
    schema: { type: 'number', default: 50 },
  })
  @ApiOkResponse({
    description: '제외 상태 정보',
    schema: {
      example: {
        statusCode: 200,
        message: 'ok',
        data: { steamId: 123456, exclusions: [] },
      },
    },
  })
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
