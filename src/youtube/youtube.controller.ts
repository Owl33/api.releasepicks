import { Controller, Get, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import { YouTubeService } from './youtube.service';
import { YouTubeSearchFilters, ApiResponse } from './youtube.types';

@Controller('api/youtube')
export class YouTubeController {
  constructor(private readonly yt: YouTubeService) {}

  @Get('trailer/:slug')
  async getTrailer(
    @Param('slug') slug: string,
    @Query('maxResults') maxResults?: string,
    @Query('lang') lang?: string,
    @Query('region') region?: string,
    @Query('strict') strict?: string,
  ): Promise<ApiResponse> {
    try {
      const filters: YouTubeSearchFilters = {
        maxResults: maxResults ? Math.max(1, Math.min(10, Number(maxResults))) : 5,
        lang: lang || undefined,
        region: region || undefined,
        strictOfficial: typeof strict === 'string' ? strict === '1' || strict === 'true' : false,
      };

      const data = await this.yt.findOfficialTrailer(slug, filters);
      return {
        success: true,
        message: data?.picked ? 'ok' : 'not found',
        data,
        timestamp: new Date().toISOString(),
      };
    } catch (e: any) {
      throw new HttpException(
        `YouTube trailer lookup failed: ${e?.message || e}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
