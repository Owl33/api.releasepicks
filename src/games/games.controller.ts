import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { GamesService } from './games.service';
import { CalendarResponseDto } from './dto/calendar.dto';
import { GameDetailResponseDto } from './dto/detail.dto';
import { HighlightsResponseDto } from './dto/highlights.dto';
import { GameFilterDto, FilteredGamesResponseDto } from './dto/filter.dto';
import { SearchGamesDto, SearchResponseDto } from './dto/search.dto';
import { GameSearchService } from './game-search.service';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
/**
 * 프론트엔드에서 직접 호출하는 게임 전용 API 컨트롤러
 */
@ApiTags('Games')
@ApiExtraModels(GameFilterDto, SearchGamesDto)
@Controller('api/games')
export class GamesController {
  constructor(
    private readonly gamesService: GamesService,
    private readonly gameSearchService: GameSearchService,
  ) {}

  // @Get('calendar')
  // async getCalendar(
  //   @Query('month') month?: string,
  // ): Promise<CalendarResponseDto> {
  //   if (!month) {
  //     throw new BadRequestException('month 쿼리 파라미터는 필수입니다.');
  //   }

  //   return this.gamesService.getCalendarByMonth(month);
  // }

  @Get('highlights')
  @ApiOperation({
    summary: '게임 하이라이트 조회',
    description: '다가오는 인기 게임과 현재 인기 있는 게임 목록을 반환합니다.',
  })
  @ApiQuery({
    name: 'upcomingLimit',
    required: false,
    schema: {
      type: 'number',
      default: 16,
      example: 16,
      minimum: 10,
      maximum: 20,
    },
    description: '다가오는 게임 최대 개수 (10~20, 기본 16)',
  })
  @ApiQuery({
    name: 'popularLimit',
    required: false,
    schema: {
      type: 'number',
      default: 16,
      example: 16,
      minimum: 10,
      maximum: 20,
    },
    description: '인기 게임 최대 개수 (10~20, 기본 16)',
  })
  @ApiOkResponse({
    description: '하이라이트 목록',
    schema: {
      example: {
        generatedAt: '2025-10-21T12:00:00.000Z',
        upcoming: [],
        popular: [],
      },
    },
  })
  async getHighlights(
    @Query('upcomingLimit') upcomingLimit?: string,
    @Query('popularLimit') popularLimit?: string,
  ): Promise<HighlightsResponseDto> {
    const upcoming = this.parseLimit(upcomingLimit, 16, 'upcomingLimit');
    const popular = this.parseLimit(popularLimit, 16, 'popularLimit');

    return this.gamesService.getHighlights(upcoming, popular);
  }

  @Get('all')
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({
    summary: '전체 게임 조회',
    description:
      '필터와 페이지네이션 파라미터를 사용해 게임 목록을 조회합니다.',
  })
  @ApiOkResponse({
    description: '필터가 적용된 게임 목록',
    schema: {
      example: {
        filters: {},
        pagination: {
          currentPage: 1,
          pageSize: 20,
          totalItems: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
        count: { total: 0, filtered: 0 },
        data: [],
      },
    },
  })
  @ApiQuery({
    name: 'month',
    required: false,
    description: '조회할 월(YYYY-MM)',
    example: '2025-11',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: '조회 시작일(YYYY-MM-DD)',
    example: '2025-10-01',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: '조회 종료일(YYYY-MM-DD)',
    example: '2025-12-31',
  })
  @ApiQuery({
    name: 'includeUnreleased',
    required: false,
    description: '미출시 게임 포함 여부',
    schema: { type: 'boolean', default: true },
  })
  @ApiQuery({
    name: 'onlyUpcoming',
    required: false,
    description: '미출시 게임만 조회',
    schema: { type: 'boolean', default: false },
  })
  @ApiQuery({
    name: 'genres',
    required: false,
    description: '장르 목록 (콤마 구분)',
    example: 'Action,RPG',
  })
  @ApiQuery({
    name: 'tags',
    required: false,
    description: '태그 목록 (콤마 구분)',
    example: 'Soulslike,Multiplayer',
  })
  @ApiQuery({
    name: 'developers',
    required: false,
    description: '개발사 목록 (콤마 구분)',
    example: 'Larian Studios,FromSoftware',
  })
  @ApiQuery({
    name: 'publishers',
    required: false,
    description: '퍼블리셔 목록 (콤마 구분)',
    example: 'Bandai Namco,Sony Interactive Entertainment',
  })
  @ApiQuery({
    name: 'platforms',
    required: false,
    description: '플랫폼 목록 (콤마 구분)',
    example: 'pc,ps5,xbox-series',
  })
  @ApiQuery({
    name: 'reviewScoreDesc',
    required: false,
    description:
      "Steam 리뷰 요약(desc) 목록 (콤마 구분). 'all', 'none' 또는 영어 원문 값 사용",
    example: 'Overwhelmingly Positive,Mixed',
  })
  @ApiQuery({
    name: 'popularityScore',
    required: false,
    description: '최소 인기도 점수 (40~100)',
    schema: { type: 'number', minimum: 40, maximum: 100, default: 40 },
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: '페이지 번호 (1 이상)',
    schema: { type: 'number', default: 1 },
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '페이지 크기 (1~200)',
    schema: { type: 'number', default: 20 },
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    description: "정렬 기준 ('releaseDate' | 'popularity' | 'name')",
    example: 'releaseDate',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    description: "정렬 순서 ('ASC' | 'DESC')",
    schema: { type: 'string', default: 'ASC' },
  })
  @ApiQuery({
    name: 'gameType',
    required: false,
    description: "게임 타입 ('all' | 'game' | 'dlc')",
    schema: { type: 'string', default: 'all' },
  })
  async getAllGames(
    @Query() filters: GameFilterDto,
  ): Promise<FilteredGamesResponseDto> {
    return this.gamesService.getAllGames(filters);
  }

  @Get('search')
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false, // 불필요한 400 방지
      transformOptions: { enableImplicitConversion: true },
    }),
  )
  @ApiOperation({
    summary: '게임 검색',
    description: '검색어를 기반으로 게임을 검색합니다.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: '검색어',
    example: 'elden ring',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: '최대 결과 수 (1~20)',
    schema: { type: 'number', default: 10 },
  })
  @ApiOkResponse({
    description: '검색 결과',
    schema: {
      example: {
        query: 'elden ring',
        count: 1,
        data: [
          {
            gameId: 123,
            name: 'ELDEN RING',
            slug: 'elden-ring',
            headerImage: 'https://example.com/header.jpg',
            releaseDate: '2022-02-25',
            popularityScore: 95,
            followersCache: 1000000,
            platforms: ['pc', 'ps5'],
            developers: ['FromSoftware'],
            publishers: ['Bandai Namco'],
          },
        ],
      },
    },
  })
  async searchGames(@Query() dto: SearchGamesDto): Promise<SearchResponseDto> {
    return this.gameSearchService.searchGames(dto);
  }

  @Get(':id')
  @ApiOperation({
    summary: '게임 상세 조회',
    description: '게임 ID로 상세 정보를 조회합니다.',
  })
  @ApiParam({
    name: 'id',
    description: '게임 ID',
    type: Number,
    example: 123,
  })
  @ApiOkResponse({
    description: '게임 상세 정보',
    schema: {
      example: {
        id: 123,
        name: 'ELDEN RING',
        slug: 'elden-ring',
        summary: '...',
        genres: ['Action', 'RPG'],
        platforms: ['pc', 'ps5'],
        releases: [],
        details: {},
      },
    },
  })
  async getGameDetail(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<GameDetailResponseDto> {
    return this.gamesService.getGameDetail(id);
  }

  /**
   * limit 파라미터를 10~20 범위로 보정하고 숫자가 아닐 경우 예외를 발생시킨다.
   */
  private parseLimit(
    value: string | undefined,
    defaultValue: number,
    key: string,
  ): number {
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${key} 파라미터는 숫자여야 합니다.`);
    }

    const floored = Math.floor(parsed);
    if (floored < 10 || floored > 20) {
      throw new BadRequestException(
        `${key} 파라미터는 10 이상 20 이하 범위만 허용됩니다.`,
      );
    }

    return floored;
  }
}
