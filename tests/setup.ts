import { AsyncLocalStorage } from "node:async_hooks";

// Next normally installs this global during server startup.
Object.assign(globalThis, { AsyncLocalStorage });
Object.assign(process.env, { NODE_ENV: "test" });
