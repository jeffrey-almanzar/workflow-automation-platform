// Environment for integration tests, set before any module is loaded.
// They run against the docker-compose Postgres, exposed on localhost:5432.

process.env.DATABASE_URL ??= 'postgres://user:password@localhost:5432/workflows';
process.env.PG_POOL_MAX ??= '10';
process.env.MOCK_LATENCY_SCALE = '0'; // no simulated vendor latency
process.env.MOCK_FAILURE_RATE = '0';
process.env.MOCK_LOST_RESPONSE_RATE = '0';
process.env.MOCK_FAILING_SYSTEMS = '';
