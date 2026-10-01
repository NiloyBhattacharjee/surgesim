#!/usr/bin/env node
import { runCli } from "./main.js";
import { ConsoleLogger, NodeClock, NodeFileStore, importModule } from "./node-host.js";

const code = await runCli(process.argv.slice(2), {
  fs: new NodeFileStore(),
  logger: new ConsoleLogger(),
  clock: new NodeClock(),
  importModule,
});
process.exitCode = code;
