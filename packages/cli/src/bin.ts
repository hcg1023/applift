#!/usr/bin/env node
import { program } from "./index.js";

program.parseAsync().catch((e: Error) => {
  process.stderr.write(`✗ ${e.message}\n`);
  process.exit(1);
});
