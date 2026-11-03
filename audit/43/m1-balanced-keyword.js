'use strict';

// AUDIT-43 M1: a deleted block keyword offset by the same keyword inserted elsewhere in the hunk escapes SG49's droppedKeyword count.
require('./repro')([['token-sites.js', 'M1']]);
