import "dotenv/config";
import { buildApp } from "./app";
import { config, validateConfig } from "./config";

const app = await buildApp();

// Validate AFTER app is built so we have a logger to report into.
// In production this hard-fails on critical issues (default JWT secret,
// missing provider credentials, etc.). In dev it just warns.
validateConfig(app.log);

await app.listen({ port: config.port, host: config.host });
app.log.info(
  `smart-loan API (${config.nodeEnv}) listening on http://${config.host}:${config.port}`,
);
