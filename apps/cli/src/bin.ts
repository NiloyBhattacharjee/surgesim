#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { runCli } from "./main.js";
import { serveMcp } from "./mcp.js";
import { ConsoleLogger, NodeClock, NodeFileStore, importModule } from "./node-host.js";

if (process.argv[2] === "mcp") {
  // stdout carries the protocol, so nothing else may print to it.
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  await serveMcp(createInterface({ input: process.stdin, crlfDelay: Infinity }), (line) => process.stdout.write(line + "\n"), { fs: new NodeFileStore(), importModule }, version);
} else {
  const code = await runCli(process.argv.slice(2), {
    fs: new NodeFileStore(),
    logger: new ConsoleLogger(),
    clock: new NodeClock(),
    importModule,
  });
  process.exitCode = code;
}
