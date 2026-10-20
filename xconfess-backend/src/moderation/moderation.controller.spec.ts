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
  let previewPolicyImpact: jest.Mock;
  let approvePolicyImpact: jest.Mock;

  beforeEach(async () => {
    runEvaluation = jest.fn().mockResolvedValue({ totalSamples: 1 });
    previewPolicyImpact = jest.fn().mockReturnValue({ fixtureCount: 1 });
    approvePolicyImpact = jest.fn().mockReturnValue({
      highThreshold: 0.9,
      mediumThreshold: 0.7,
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ModerationController],
      providers: [
        { provide: AiModerationService, useValue: {} },
        { provide: ModerationRepositoryService, useValue: {} },
        {
          provide: LanguageEvaluationService,
          useValue: { runEvaluation, previewPolicyImpact, approvePolicyImpact },
        },
      ],
    }).compile();

    controller = module.get(ModerationController);
  });

  it('routes threshold previews and explicit approvals through the evaluation service', () => {
    const proposal = { highThreshold: 0.9, mediumThreshold: 0.7 };
    const preview = controller.previewPolicyImpact(proposal);

    expect(previewPolicyImpact).toHaveBeenCalledWith(proposal);
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        ModerationController.prototype.previewPolicyImpact,
      ),
    ).toBe('policy-impact-preview');
    expect(
      controller.updateThresholds({
        ...proposal,
        approved: true,
        previewId: '8c0af69e-4ed3-47aa-9df5-0bd49f51e084',
      }),
    ).toMatchObject({ thresholds: proposal });
    expect(approvePolicyImpact).toHaveBeenCalledWith({
      previewId: '8c0af69e-4ed3-47aa-9df5-0bd49f51e084',
      approved: true,
      proposedThresholds: proposal,
    });
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
