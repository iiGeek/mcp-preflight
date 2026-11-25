#!/usr/bin/env node
'use strict';

const { main } = require('../lib/cli');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 2;
  });
