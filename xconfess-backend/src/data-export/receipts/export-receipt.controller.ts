import {
  Controller,
  Get,
  Param,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { ExportReceiptService } from './export-receipt.service';
import { ExportReceipt, RequestingUserContext } from './export-receipt.types';

@Controller('exports/receipts')
export class ExportReceiptController {
  constructor(private readonly receiptService: ExportReceiptService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async listUserReceipts(@Req() req: any): Promise<ExportReceipt[]> {
    const userContext = this.extractUserContext(req);
    return this.receiptService.listReceiptsForUser(userContext);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getReceipt(@Param('id') id: string, @Req() req: any): Promise<ExportReceipt> {
    const userContext = this.extractUserContext(req);
    return this.receiptService.getReceiptForUser(id, userContext);
  }

  private extractUserContext(req: any): RequestingUserContext {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication credentials missing');
    }
    return {
      userId,
      role: req.user?.role || 'USER',
    };
  }
}
