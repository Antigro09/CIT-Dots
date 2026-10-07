import { createApp } from "./api";
import { config } from "./config";
const app = createApp();
await app.listen({ host: config.host, port: config.port });
await app.broker.start();
console.log(`CIT Dots control service: ${config.controlUrl}`);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => {
      app.broker.store.close();
      process.exit(0);
    });
  });
