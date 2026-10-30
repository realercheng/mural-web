import { createApp, jsonLog } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { server } = createApp(config);
server.listen(config.port, () => jsonLog('server_started', {
  port: config.port, model: config.model, maxSessionSeconds: config.maxSessionSeconds,
  dailyLimitSeconds: config.dailyLimitSeconds, totalLimitSeconds: config.totalLimitSeconds,
}));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
