import { PORT } from './config.js';
import { buildApp } from './app.js';

const app = buildApp();

app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
