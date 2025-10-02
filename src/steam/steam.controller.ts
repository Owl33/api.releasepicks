import { Controller, Get, Param } from '@nestjs/common';
import { SteamCommunityService } from './services/steam-community.service';
import { SteamReviewService } from './services/steam-review.service';
@Controller('api/steam')
export class SteamController {
  constructor(
    private readonly SteamReviewService: SteamReviewService,
    private readonly SteamCommunityService: SteamCommunityService,
  ) {}

  @Get('/review')
  getHello(): any {
    return this.SteamReviewService.fetchAppReview(440);
  }
  @Get('followers/app/:appid')
  async followers(@Param('appid') appid: string) {
    const n = await this.SteamCommunityService.scrapeFollowers(
      Number(appid),
      'Nioh 3',
    );
    return { appid, followers: n };
  }
}
