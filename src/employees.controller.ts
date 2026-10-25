// Controller exposing the employee system of record (PostgreSQL), including the audit trail.

import { Controller, Get, Param } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('employees')
export class EmployeesController {
  constructor(private readonly db: DatabaseService) {}

  @Get(':employeeId')
  get(@Param('employeeId') employeeId: string) {
    return this.db.getEmployee(employeeId);
  }
}
