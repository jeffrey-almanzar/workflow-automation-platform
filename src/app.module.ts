// Root NestJS module that wires up the controllers and services.

import { Module } from '@nestjs/common';
import { OffboardingController } from './offboarding.controller';
import { OnboardingController } from './onboarding.controller';
import { TemporalService } from './temporal.service';

@Module({
  imports: [],
  controllers: [OnboardingController, OffboardingController],
  providers: [TemporalService],
})
export class AppModule {}
