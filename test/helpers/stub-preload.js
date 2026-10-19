'use strict';

// Preloaded with `node -r` into a spawned CLI so it uses the stub client
// for the fixture named by STUB_FIXTURE (no production test hook needed).
const { installStub, loadFixtureResponses } = require('./stub-client');

installStub(loadFixtureResponses(process.env.STUB_FIXTURE));
