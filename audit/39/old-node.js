'use strict';
// Preload (NODE_OPTIONS --require, before the runner's load hook): makes this
// node look like one without `module.registerHooks` (Node < 22.15 / 23.5;
// package.json allows >= 18).
delete require('module').registerHooks;
