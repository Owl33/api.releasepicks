import { Controller, Get, Param } from '@nestjs/common';
import { SteamCommunityService } from './services/steam-community.service';
import { SteamReviewService } from './services/steam-review.service';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
@ApiTags('Steam')
@Controller('api/steam')
export class SteamController {
  constructor(
    private readonly SteamReviewService: SteamReviewService,
    private readonly SteamCommunityService: SteamCommunityService,
  ) {}

  @Get('/review')
  @ApiOperation({ summary: '샘플 리뷰 수집', description: '내부 테스트용: 고정 AppID 리뷰 데이터를 반환합니다.' })
  @ApiOkResponse({ description: '리뷰 통계', schema: { example: { success: true } } })
  getHello(): any {
    return this.SteamReviewService.fetchAppReview(440);
  }
  @Get('followers/app/:appid')
  @ApiOperation({ summary: 'Steam 팔로워 수 조회' })
  @ApiParam({ name: 'appid', description: 'Steam AppID', example: '123456' })
  @ApiOkResponse({
    description: '팔로워 수',
    schema: {
      example: {
        appid: '123456',
        followers: 12345,
      },
    },
  })
  async followers(@Param('appid') appid: string) {
    const n = await this.SteamCommunityService.scrapeFollowers(
      Number(appid),
      'Nioh 3',
    );
    return { appid, followers: n };
  }
}
