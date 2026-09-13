import { logger } from './logger.js';
import { validateRequiredConfig } from './configValidation.js';

async function main() {
  const command = process.argv[2];
  if (command === 'status' || command === 'api-usage') {
    const { runStatusCommand } = await import('./status.js');
    runStatusCommand(command);
    return;
  }
  if (command && command !== '--check-config') throw new Error('Unknown command. Use status, api-usage, or --check-config.');
  if (!validateRequiredConfig()) {
    process.exit(1);
  }
  if (command === '--check-config') return;

  logger.info('VK auction bot starting...');
  const [{ logStartupDiagnostics }, { startScheduler }] = await Promise.all([
    import('./startupDiagnostics.js'),
    import('./scheduler.js')
  ]);

  logStartupDiagnostics();
  const stopScheduler = startScheduler();
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: stopping scheduler...`);
    await stopScheduler();
    const { db } = await import('./db.js');
    db.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => stop(signal).catch((error) => {
      logger.error('Shutdown failed:', error.message);
      process.exitCode = 1;
    }));
  }
}

main().catch((error) => {
  logger.error('Fatal startup error:', error.message || error);
  process.exit(1);
});
