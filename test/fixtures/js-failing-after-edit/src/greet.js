'use strict';

const DEBUG = Boolean(process.env.GREET_DEBUG);
const GREETING = 'hello';

function greet(name) {
  if (DEBUG) console.log('greet', name);
  return GREETING + ', ' + name;
}

module.exports = { greet };
