#!/usr/bin/env node
import { runCli } from "./main.js";
import { ConsoleLogger, NodeClock, NodeFileStore } from "./node-host.js";

const code = await runCli(process.argv.slice(2), {
  fs: new NodeFileStore(),
  logger: new ConsoleLogger(),
  clock: new NodeClock(),
});
process.exitCode = code;
