#!/usr/bin/env bun

import {
  install,
  uninstall,
  start,
  stop,
  restart,
  status,
  logs,
} from "./cli/commands.ts";

const USAGE = `psibot - Manage the psibot daemon

Usage: psibot <command> [options]

Commands:
  install      Install LaunchAgent and bootstrap service
  uninstall    Remove LaunchAgent and unload service
  start        Start the daemon
  stop         Stop the daemon (graceful SIGTERM)
  restart      Restart the daemon
  status       Show daemon status
  logs         Tail log files

Logs options:
  --err        Show stderr log (default: stdout)
  -f           Follow (live tail)
  -n <lines>   Number of lines (default: 50)
`;

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "install":
    await install();
    break;
  case "uninstall":
    await uninstall();
    break;
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await restart();
    break;
  case "status":
    await status();
    break;
  case "logs":
    await logs(args.slice(1));
    break;
  case "--help":
  case "-h":
  case undefined:
    console.log(USAGE);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(USAGE);
    process.exit(1);
}
