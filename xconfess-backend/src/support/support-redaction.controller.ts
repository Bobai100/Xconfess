import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { SupportRedactionService } from './support-redaction.service';
import { RawSupportPayload, SupportReportPreview, SubmittedSupportReport } from './support-redaction.types';

@Controller('support')
export class SupportRedactionController {
  constructor(private readonly supportService: SupportRedactionService) {}

  @Post('preview')
  async previewReport(@Body() payload: RawSupportPayload): Promise<SupportReportPreview> {
    return this.supportService.generatePreview(payload);
  }

  @Post('submit')
  async submitReport(
    @Body('previewId') previewId: string,
    @Req() req: any,
  ): Promise<SubmittedSupportReport> {
    const userId = req.user?.id || req.user?.userId;
    return this.supportService.submitReport(previewId, userId);
  }
}
