import { logger } from './logger.js';
import { validateRequiredConfig } from './configValidation.js';

async function main() {
  if (!validateRequiredConfig()) {
    process.exit(1);
  }

  logger.info('VK auction bot starting...');
  const [{ logStartupDiagnostics }, { startScheduler }] = await Promise.all([
    import('./startupDiagnostics.js'),
    import('./scheduler.js')
  ]);

  logStartupDiagnostics();
  startScheduler();
}

main().catch((error) => {
  logger.error('Fatal startup error:', error.message || error);
  process.exit(1);
});
