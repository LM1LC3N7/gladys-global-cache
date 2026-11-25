// -----------------------------------------------------------------------------
// Entry point of the container: SDK wiring only (src/handlers.js registers
// every handler BEFORE connect(), and delegates to the GlobalCacheApp of
// src/app.js). The relay releases kept in /data are sent before Gladys is
// even reached (app.boot()).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { GlobalCacheApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new GlobalCacheApp({ gladys, logger });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.stop());

logger.info('Starting the Global Caché integration...');
app.boot().catch((err) => logger.warn('/data not read at start', err?.message));
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err?.message);
  process.exit(1);
});
