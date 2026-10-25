// Read side of our PostgreSQL data for the API: employee records and their audit trail.

import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { migrate, pool } from './db';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await migrate();
  }

  async onModuleDestroy() {
    await pool.end();
  }

  async getEmployee(employeeId: string) {
    const employee = await pool.query('SELECT * FROM employees WHERE employee_id = $1', [employeeId]);
    if (employee.rowCount === 0) throw new NotFoundException(`Employee ${employeeId} not found`);
    const audit = await pool.query(
      'SELECT created_at, workflow_id, event, details FROM audit_log WHERE employee_id = $1 ORDER BY id',
      [employeeId],
    );
    return { ...employee.rows[0], auditLog: audit.rows };
  }
}
