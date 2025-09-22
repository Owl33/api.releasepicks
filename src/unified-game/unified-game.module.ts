import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnifiedGameController } from './unified-game.controller';
import { UnifiedGameService } from './unified-game.service';
import { Game } from '../entities/game.entity';
import { GameDetail } from '../entities/game-detail.entity';
import { RawgModule } from '../rawg/rawg.module';
import { SteamModule } from '../steam/steam.module';
import { YouTubeModule } from '../youtube/youtube.module';

/**
 * 통합 게임 캘린더 모듈
 * user_request.md 명세 구현: RAWG + Steam + Reviews 통합 처리
 *
 * 의존성:
 * - RawgModule: RAWG API 처리 및 DLC 필터링
 * - SteamModule: Steam API 처리 및 리뷰 통합
 * - YouTubeModule: YouTube 트레일러 검색
 * - TypeORM: Game, GameDetail 엔티티
 */
@Module({
  imports: [
    // TypeORM 엔티티 등록
    TypeOrmModule.forFeature([Game, GameDetail]),

    // 외부 서비스 모듈 임포트
    RawgModule,
    SteamModule,
    YouTubeModule,
  ],
  controllers: [UnifiedGameController],
  providers: [UnifiedGameService],
  exports: [UnifiedGameService], // 다른 모듈에서도 사용 가능하도록 export
})
export class UnifiedGameModule {}