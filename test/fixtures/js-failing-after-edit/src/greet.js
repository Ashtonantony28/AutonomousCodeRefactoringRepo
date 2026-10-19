'use strict';

const GREETING = 'hello';

function greet(name) {
  console.log('greet', name);
  return GREETING + ', ' + name;
}

module.exports = { greet };
