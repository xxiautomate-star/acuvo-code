// ⚠️ The budget line names the hardware the price table charged (2026-09-26, a
// real run): one `see_page` screenshot printed "$0.0032 of that is GPU time"
// while its own ledger entry said "at the published cpu rate".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, chargeGpu, resetSpendMeter, computeNoun } from '../lib/budget.mjs';

test('a hosted browser screenshot is CPU time, not GPU time', (t) => {
  resetSpendMeter();
  t.after(resetSpendMeter);
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.001 });
  chargeGpu({ verb: 'see_page', seconds: 12, endpoint: 'https://render' });
  const line = b.report();
  assert.match(line, /of that is hosted CPU time on 1 call/);
  assert.doesNotMatch(line, /GPU time/);
});

test('a GPU verb still reads exactly "GPU time", and a mix says compute', (t) => {
  resetSpendMeter();
  t.after(resetSpendMeter);
  const b = createBudget({ limitUsd: 1 });
  b.record({ costUsd: 0.001 });
  chargeGpu({ verb: 'generate_image', seconds: 9, endpoint: 'https://engine' });
  assert.match(b.report(), /of that is GPU time on 1 call/);
  chargeGpu({ verb: 'see_page', seconds: 3, endpoint: 'https://render' });
  assert.match(b.report(), /of that is hosted compute on 2 calls/);
  assert.equal(computeNoun(['gpu']), 'GPU time');
  assert.equal(computeNoun(['cpu']), 'hosted CPU time');
  assert.equal(computeNoun(['vision']), 'hosted compute');
});
