import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiModerationService } from './ai-moderation.service';
import { ModerationRepositoryService } from './moderation-repository.service';
import { LanguageEvaluationService } from './language-evaluation.service';
import { ModerationController } from './moderation.controller';
import { RunEvaluationDto } from './dtos/run-evaluation.dto';

describe('ModerationController language evaluation', () => {
  let controller: ModerationController;
  let runEvaluation: jest.Mock;

  beforeEach(async () => {
    runEvaluation = jest.fn().mockResolvedValue({ totalSamples: 1 });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ModerationController],
      providers: [
        { provide: AiModerationService, useValue: {} },
        { provide: ModerationRepositoryService, useValue: {} },
        {
          provide: LanguageEvaluationService,
          useValue: { runEvaluation },
        },
      ],
    }).compile();

    controller = module.get(ModerationController);
  });

  it('exposes evaluation only on the authenticated admin moderation controller', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ModerationController)).toEqual([
      JwtAuthGuard,
      AdminGuard,
    ]);
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        ModerationController.prototype.runLanguageEvaluation,
      ),
    ).toBe('language-evaluation');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        ModerationController.prototype.runLanguageEvaluation,
      ),
    ).toBe(RequestMethod.POST);

    const dto = new RunEvaluationDto();
    dto.languages = ['en'];
    const report = await controller.runLanguageEvaluation(dto);

    expect(runEvaluation).toHaveBeenCalledWith(dto);
    expect(report).toEqual({ totalSamples: 1 });
  });

  it('propagates evaluation failures to the HTTP exception handling boundary', async () => {
    const error = new Error('Moderation unavailable');
    runEvaluation.mockRejectedValue(error);

    await expect(
      controller.runLanguageEvaluation(new RunEvaluationDto()),
    ).rejects.toBe(error);
  });
});
