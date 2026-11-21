"use strict";
const c = require("./config.json");
const problems = [];
if (!(c.timeout_ms >= 1000)) problems.push(`timeout_ms ${c.timeout_ms} is below the upstream p99 (see logs/server.log)`);
if (!(c.retry_limit >= 2)) problems.push(`retry_limit ${c.retry_limit} allows no retry (see logs/server.log)`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("config ok");
