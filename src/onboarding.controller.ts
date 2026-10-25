// Controller exposing endpoints to start, advance, cancel and monitor employee onboardings.

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { IsDateString, IsEmail, IsIn, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { NewHire, ROLES, Role } from './shared';
import { TemporalService } from './temporal.service';

export class CreateOnboardingDto implements NewHire {
  @Matches(/^[A-Za-z0-9-]{1,64}$/, { message: 'employeeId must be alphanumeric (dashes allowed)' })
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsEmail()
  personalEmail!: string;

  @IsIn(ROLES)
  role!: Role;

  @IsDateString({ strict: true })
  startDate!: string;
}

export class UpdateStartDateDto {
  @IsDateString({ strict: true })
  startDate!: string;
}

export class CancelOnboardingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

@Controller('onboardings')
export class OnboardingController {
  constructor(private readonly temporalService: TemporalService) {}

  // 202: the onboarding has been accepted and runs asynchronously in the worker.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async start(@Body() dto: CreateOnboardingDto) {
    const onboardingId = await this.temporalService.startOnboarding(dto);
    return { onboardingId };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.temporalService.getOnboarding(id);
  }

  // Called by the e-signature provider's webhook (or manually, for now).
  @Post(':id/contract-signature')
  @HttpCode(HttpStatus.ACCEPTED)
  signContract(@Param('id') id: string) {
    return this.temporalService.signContract(id);
  }

  @Patch(':id/start-date')
  @HttpCode(HttpStatus.ACCEPTED)
  updateStartDate(@Param('id') id: string, @Body() dto: UpdateStartDateDto) {
    return this.temporalService.updateStartDate(id, dto.startDate);
  }

  // E.g. the offer was withdrawn. Undoes everything completed so far (saga).
  @Post(':id/cancellation')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id') id: string, @Body() dto: CancelOnboardingDto) {
    return this.temporalService.cancelOnboarding(id, dto.reason);
  }
}
