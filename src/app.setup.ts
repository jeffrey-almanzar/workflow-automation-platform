// App-wide configuration, shared by main.ts and the API tests so both run the same pipeline.

import { INestApplication, ValidationPipe } from '@nestjs/common';

export function configureApp(app: INestApplication): void {
  // Reject malformed request bodies (and unknown fields) before they reach Temporal.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
}
