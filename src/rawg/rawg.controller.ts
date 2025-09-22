import { Controller, Post, Param } from '@nestjs/common';
import { RawgService } from './rawg.service';

@Controller('rawg')
export class RawgController {
  constructor(private readonly rawgService: RawgService) {}

  // ✅ 모든 RAWG 저장 기능은 UnifiedGameController로 이관됨
  // 📝 이 컨트롤러는 RAWG API 호출 기능만 유지
}
