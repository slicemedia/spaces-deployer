#!/usr/bin/env node
import { runSpacesCli } from "./cli.js";

process.exitCode = await runSpacesCli(process.argv.slice(2));
