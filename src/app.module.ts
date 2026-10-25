// Root NestJS module that wires up the controllers and services.

import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { EmployeesController } from './employees.controller';
import { OffboardingController } from './offboarding.controller';
import { OnboardingController } from './onboarding.controller';
import { TemporalService } from './temporal.service';

@Module({
  imports: [],
  controllers: [OnboardingController, OffboardingController, EmployeesController],
  providers: [TemporalService, DatabaseService],
})
export class AppModule {}
