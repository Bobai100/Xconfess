import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TopicService } from './topic.service';
import {
  CreateTopicDto,
  UpdateTopicDto,
  AddTopicAliasDto,
  MergeTopicDto,
} from './dto/topic.dto';
import { TopicStatus } from './entities/topic.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';

@Controller('admin/topics')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminTopicController {
  constructor(private readonly topicService: TopicService) {}

  @Post()
  async createTopic(@Request() req: any, @Body() dto: CreateTopicDto) {
    return this.topicService.createTopic(dto, req.user?.id);
  }

  @Get()
  async listTopics(@Query('status') status?: TopicStatus) {
    return this.topicService.listTopics(status);
  }

  @Get(':id')
  async getTopic(@Param('id') id: string) {
    return this.topicService.getTopicById(id);
  }

  @Patch(':id')
  async updateTopic(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateTopicDto,
  ) {
    return this.topicService.updateTopic(id, dto, req.user?.id);
  }

  @Post(':id/aliases')
  async addAlias(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: AddTopicAliasDto,
  ) {
    return this.topicService.addAlias(id, dto, req.user?.id);
  }

  @Delete(':id/aliases/:alias')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAlias(
    @Request() req: any,
    @Param('id') id: string,
    @Param('alias') alias: string,
  ) {
    return this.topicService.removeAlias(id, alias, req.user?.id);
  }

  @Post(':id/retire')
  async retireTopic(@Request() req: any, @Param('id') id: string) {
    return this.topicService.retireTopic(id, req.user?.id);
  }

  @Post(':id/merge')
  async mergeTopics(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: MergeTopicDto,
  ) {
    return this.topicService.mergeTopics(id, dto, req.user?.id);
  }
}

@Controller('topics')
export class PublicTopicController {
  constructor(private readonly topicService: TopicService) {}

  @Get()
  async getActiveTopics() {
    return this.topicService.listTopics(TopicStatus.ACTIVE);
  }

  @Get('resolve/:identifier')
  async resolveTopic(@Param('identifier') identifier: string) {
    return this.topicService.resolveTopic(identifier);
  }
}
