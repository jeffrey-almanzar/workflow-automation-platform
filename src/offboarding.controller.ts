// Controller exposing endpoints to start and monitor employee offboardings.

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { IsDateString, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { TemporalService } from './temporal.service';

export class CreateOffboardingDto {
  @Matches(/^[A-Za-z0-9-]{1,64}$/, { message: 'employeeId must be alphanumeric (dashes allowed)' })
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  // Omit to revoke access immediately.
  @IsOptional()
  @IsDateString({ strict: true })
  revokeAccessAt?: string;
}

@Controller('offboardings')
export class OffboardingController {
  constructor(private readonly temporalService: TemporalService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async start(@Body() dto: CreateOffboardingDto) {
    const offboardingId = await this.temporalService.startOffboarding(dto.employeeId, dto.reason, dto.revokeAccessAt);
    return { offboardingId };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.temporalService.getOffboarding(id);
  }
}
