import 'dotenv/config';
import { Client } from 'pg';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

type Role = 'anon' | 'service_role';
type Action = 'select' | 'insert';

interface CheckResult {
  role: Role;
  action: Action;
  success: boolean;
  error?: string;
}

(async () => {
  const startedAt = new Date().toISOString();
  const logDir = join(process.cwd(), 'logs');
  mkdirSync(logDir, { recursive: true });

  const output: {
    startedAt: string;
    endedAt?: string;
    connectionError?: string;
    checks: CheckResult[];
  } = {
    startedAt,
    checks: [],
  };

  const logPath = join(logDir, `rls-check-${startedAt.replace(/[:.]/g, '-')}.json`);

  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? '5432'),
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  const finalize = (exitCode: number) => {
    output.endedAt = new Date().toISOString();
    writeFileSync(logPath, JSON.stringify(output, null, 2), 'utf8');
    process.exit(exitCode);
  };

  try {
    await client.connect();
  } catch (error) {
    output.connectionError = error instanceof Error ? error.message : String(error);
    finalize(1);
    return;
  }

  const runCheck = async (role: Role, action: Action, sql: string, params: unknown[] = []) => {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(sql, params);
      output.checks.push({ role, action, success: true });
    } catch (error) {
      output.checks.push({
        role,
        action,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await client.query('ROLLBACK');
    }
  };

  try {
    await runCheck('anon', 'select', 'SELECT id FROM public.games LIMIT 1');
    await runCheck('anon', 'insert', "INSERT INTO public.job_runs (job_type) VALUES ('rls-check-anon')");
    await runCheck('service_role', 'insert', "INSERT INTO public.job_runs (job_type) VALUES ('rls-check-service')");
  } catch (error) {
    output.checks.push({
      role: 'service_role',
      action: 'insert',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.end().catch(() => undefined);
  }

  finalize(0);
})();
