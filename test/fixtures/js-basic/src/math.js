'use strict';

function add(a, b) {
  const result = a + b;
  return result;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

module.exports = { add, safeParse };
