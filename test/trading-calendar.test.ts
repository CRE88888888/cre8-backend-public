import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stockMarketOpen} from '../src/trading-calendar.js';
test('#83 NYSE session equality, exclusive close, weekend, holidays, early close and DST',()=>{
  for(const [time,expected] of [
    ['2026-11-16T14:29:59Z',false],['2026-11-16T14:30:00Z',true],['2026-11-16T20:59:59Z',true],['2026-11-16T21:00:00Z',false],
    ['2026-11-15T16:00:00Z',false],['2026-11-26T16:00:00Z',false],['2026-11-27T17:59:59Z',true],['2026-11-27T18:00:00Z',false],
    ['2026-12-24T18:00:00Z',false],['2027-03-12T14:30:00Z',true],['2027-03-15T13:30:00Z',true],['2027-03-15T20:00:00Z',false],
    ['2027-03-26T16:00:00Z',false],['2028-07-03T17:00:00Z',false],['2028-06-19T16:00:00Z',false],['2029-01-02T16:00:00Z',false],
    ['2027-12-31T16:00:00Z',true],['2027-12-24T16:00:00Z',false],
  ] as const)assert.equal(stockMarketOpen(new Date(time)),expected,time);
  assert.throws(()=>stockMarketOpen(new Date('invalid')));
});
