import { Module } from '@nestjs/common';
import { RawgService } from './rawg.service';
import { RawgController } from './rawg.controller';
import { YouTubeModule } from '../youtube/youtube.module';

@Module({
  imports: [YouTubeModule],
  providers: [RawgService],
  controllers: [RawgController],
  exports: [RawgService],
})
export class RawgModule {}