import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '..', 'package.json');
import {
  TokenBucket, SlidingWindow, FixedWindow, LeakyBucket,
  RateLimiter, createRateLimiter,
  VERSION,
} from '../src/index.js';

// Helper: controllable mock clock
function mockTime(start = 1000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  fn.set = (ms) => { t = ms; };
  return fn;
}

// ─── TokenBucket ─────────────────────────────────────────────

test('TokenBucket starts at full capacity', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 1, timeProvider: clock });
  assert.equal(tb.available, 10);
});

test('TokenBucket tryConsume reduces tokens', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 1, timeProvider: clock });
  assert.equal(tb.tryConsume(3), true);
  assert.equal(tb.available, 7);
});

test('TokenBucket tryConsume fails when insufficient', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 5, tokensPerSecond: 1, timeProvider: clock });
  assert.equal(tb.tryConsume(3), true);
  assert.equal(tb.tryConsume(3), false);
  assert.equal(tb.available, 2);
});

test('TokenBucket refills over time', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 2, timeProvider: clock });
  tb.tryConsume(10);
  assert.equal(tb.available, 0);
  assert.equal(tb.tryConsume(1), false);
  clock.advance(1000); // 1s → +2 tokens
  assert.equal(tb.available, 2);
});

test('TokenBucket does not exceed capacity on refill', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 100, tokens: 0, timeProvider: clock });
  clock.advance(99999);
  assert.equal(tb.available, 10); // capped at capacity
});

test('TokenBucket reset restores full capacity', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 1, timeProvider: clock });
  tb.tryConsume(5);
  tb.reset();
  assert.equal(tb.available, 10);
});

test('TokenBucket accepts custom initial tokens', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 1, tokens: 3, timeProvider: clock });
  assert.equal(tb.available, 3);
});

test('TokenBucket serialization roundtrip preserves state', () => {
  const clock = mockTime();
  const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 2, timeProvider: clock });
  tb.tryConsume(4);
  const json = tb.toJSON();
  assert.equal(json.tokens, 6);
  const restored = TokenBucket.fromJSON(json);
  assert.equal(restored.capacity, 10);
  assert.equal(restored.tokensPerSecond, 2);
  assert.equal(restored.tokens, 6); // raw field, no refill triggered
  assert.equal(restored.lastRefill, json.lastRefill);
});

test('TokenBucket invalid constructor params throw', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, tokensPerSecond: 1 }), TypeError);
  assert.throws(() => new TokenBucket({ capacity: 10, tokensPerSecond: 0 }), TypeError);
  assert.throws(() => new TokenBucket({ capacity: 10, tokensPerSecond: 1, tokens: -1 }), RangeError);
  assert.throws(() => new TokenBucket({ capacity: 10, tokensPerSecond: 1, tokens: 11 }), RangeError);
});

test('TokenBucket consume resolves when tokens available', async () => {
  const tb = new TokenBucket({ capacity: 1, tokensPerSecond: 1000, tokens: 0 });
  // 1000 tokens/sec → 1 token in ~1ms
  await tb.consume(1);
  assert.ok(true, 'consume resolved');
});

// ─── SlidingWindow ───────────────────────────────────────────

test('SlidingWindow allows up to limit', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 5, windowMs: 1000, timeProvider: clock });
  for (let i = 0; i < 5; i++) assert.equal(sw.tryConsume(), true);
  assert.equal(sw.tryConsume(), false);
});

test('SlidingWindow rejects when over limit', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 3, windowMs: 1000, timeProvider: clock });
  assert.equal(sw.tryConsume(3), true);
  assert.equal(sw.tryConsume(1), false);
  assert.equal(sw.available, 0);
});

test('SlidingWindow uses weighted estimate across windows', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 3, windowMs: 1000, timeProvider: clock });
  sw.tryConsume(3); // fill window [0,1000)
  assert.equal(sw.tryConsume(), false);
  clock.advance(1500); // now at 1500 → window [1000,2000), prev weight = 0.5
  // estimate = 3 * 0.5 + 0 = 1.5 → available = floor(3 - 1.5) = 1
  assert.equal(sw.available, 1);
  assert.equal(sw.tryConsume(1), true); // 1.5 + 1 = 2.5 ≤ 3
});

test('SlidingWindow fully resets after 2+ windows', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 2, windowMs: 1000, timeProvider: clock });
  sw.tryConsume(2);
  clock.advance(2500); // 2+ windows passed → prev and curr cleared
  assert.equal(sw.available, 2);
  assert.equal(sw.tryConsume(2), true);
});

test('SlidingWindow smooth estimate at mid-window', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 10, windowMs: 1000, timeProvider: clock });
  sw.tryConsume(10);
  clock.advance(1500); // mid-window in next period
  // prevCount=10, weight=0.5 → estimate = 5
  assert.equal(sw.available, 5);
  assert.equal(sw.tryConsume(5), true);
});

test('SlidingWindow reset', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 5, windowMs: 1000, timeProvider: clock });
  sw.tryConsume(3);
  sw.reset();
  assert.equal(sw.available, 5);
});

test('SlidingWindow serialization roundtrip', () => {
  const clock = mockTime(0);
  const sw = new SlidingWindow({ limit: 5, windowMs: 1000, timeProvider: clock });
  sw.tryConsume(2);
  const json = sw.toJSON();
  const restored = SlidingWindow.fromJSON(json);
  assert.equal(restored.limit, 5);
  assert.equal(restored.currCount, 2);
});

test('SlidingWindow invalid params throw', () => {
  assert.throws(() => new SlidingWindow({ limit: 0, windowMs: 1000 }), TypeError);
  assert.throws(() => new SlidingWindow({ limit: 5, windowMs: 0 }), TypeError);
});

// ─── FixedWindow ─────────────────────────────────────────────

test('FixedWindow allows up to limit', () => {
  const clock = mockTime(0);
  const fw = new FixedWindow({ limit: 5, windowMs: 1000, timeProvider: clock });
  for (let i = 0; i < 5; i++) assert.equal(fw.tryConsume(), true);
  assert.equal(fw.tryConsume(), false);
});

test('FixedWindow resets count at window boundary', () => {
  const clock = mockTime(0);
  const fw = new FixedWindow({ limit: 3, windowMs: 1000, timeProvider: clock });
  fw.tryConsume(3);
  assert.equal(fw.tryConsume(), false);
  clock.advance(1000);
  assert.equal(fw.tryConsume(3), true);
});

test('FixedWindow reset', () => {
  const clock = mockTime(0);
  const fw = new FixedWindow({ limit: 5, windowMs: 1000, timeProvider: clock });
  fw.tryConsume(3);
  fw.reset();
  assert.equal(fw.available, 5);
});

test('FixedWindow serialization roundtrip', () => {
  const clock = mockTime(0);
  const fw = new FixedWindow({ limit: 5, windowMs: 1000, timeProvider: clock });
  fw.tryConsume(2);
  const json = fw.toJSON();
  const restored = FixedWindow.fromJSON(json);
  assert.equal(restored.limit, 5);
  assert.equal(restored.count, 2);
});

test('FixedWindow invalid params throw', () => {
  assert.throws(() => new FixedWindow({ limit: 0, windowMs: 1000 }), TypeError);
  assert.throws(() => new FixedWindow({ limit: 5, windowMs: -1 }), TypeError);
});

// ─── LeakyBucket ─────────────────────────────────────────────

test('LeakyBucket starts with full availability', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 1, timeProvider: clock });
  assert.equal(lb.available, 10);
});

test('LeakyBucket tryAdd reduces available capacity', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 1, timeProvider: clock });
  assert.equal(lb.tryAdd(3), true);
  assert.equal(lb.available, 7);
});

test('LeakyBucket rejects when capacity exceeded', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 5, leakPerSecond: 1, timeProvider: clock });
  assert.equal(lb.tryAdd(5), true);
  assert.equal(lb.tryAdd(1), false);
});

test('LeakyBucket leaks over time', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 5, timeProvider: clock });
  lb.tryAdd(10);
  assert.equal(lb.available, 0);
  clock.advance(1000); // 1s → leaks 5
  assert.equal(lb.available, 5);
});

test('LeakyBucket level never goes below zero', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 100, timeProvider: clock });
  lb.tryAdd(5);
  clock.advance(99999);
  assert.equal(lb.available, 10); // fully leaked
});

test('LeakyBucket tryConsume alias works like tryAdd', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 1, timeProvider: clock });
  assert.equal(lb.tryConsume(3), true);
  assert.equal(lb.available, 7);
});

test('LeakyBucket reset clears level', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 1, timeProvider: clock });
  lb.tryAdd(5);
  lb.reset();
  assert.equal(lb.available, 10);
});

test('LeakyBucket serialization roundtrip', () => {
  const clock = mockTime();
  const lb = new LeakyBucket({ capacity: 10, leakPerSecond: 2, timeProvider: clock });
  lb.tryAdd(4);
  const json = lb.toJSON();
  assert.equal(json.level, 4);
  const restored = LeakyBucket.fromJSON(json);
  assert.equal(restored.capacity, 10);
  assert.equal(restored.leakPerSecond, 2);
  assert.equal(restored.level, 4); // raw field, no leak triggered
  assert.equal(restored.lastLeak, json.lastLeak);
});

test('LeakyBucket invalid params throw', () => {
  assert.throws(() => new LeakyBucket({ capacity: 0, leakPerSecond: 1 }), TypeError);
  assert.throws(() => new LeakyBucket({ capacity: 10, leakPerSecond: 0 }), TypeError);
});

// ─── RateLimiter (Keyed) ─────────────────────────────────────

test('RateLimiter creates independent per-key limiters', () => {
  const rl = new RateLimiter('token-bucket', { capacity: 5, tokensPerSecond: 1 });
  assert.equal(rl.size, 0);
  assert.equal(rl.tryConsume('user1', 3), true);
  assert.equal(rl.size, 1);
  assert.equal(rl.tryConsume('user2', 3), true);
  assert.equal(rl.size, 2);
  assert.equal(rl.tryConsume('user1', 3), false); // user1 exhausted
});

test('RateLimiter reset specific key', () => {
  const rl = new RateLimiter('fixed-window', { limit: 5, windowMs: 1000 });
  rl.tryConsume('user1', 3);
  rl.reset('user1');
  assert.equal(rl.tryConsume('user1', 5), true);
});

test('RateLimiter reset all keys', () => {
  const rl = new RateLimiter('fixed-window', { limit: 5, windowMs: 1000 });
  rl.tryConsume('user1', 3);
  rl.tryConsume('user2', 3);
  rl.reset();
  assert.equal(rl.tryConsume('user1', 5), true);
  assert.equal(rl.tryConsume('user2', 5), true);
});

test('RateLimiter delete removes a key', () => {
  const rl = new RateLimiter('token-bucket', { capacity: 5, tokensPerSecond: 1 });
  rl.tryConsume('user1');
  assert.equal(rl.size, 1);
  rl.delete('user1');
  assert.equal(rl.size, 0);
});

test('RateLimiter works with all four strategies', () => {
  const cases = [
    ['token-bucket', { capacity: 5, tokensPerSecond: 1 }],
    ['sliding-window', { limit: 5, windowMs: 1000 }],
    ['fixed-window', { limit: 5, windowMs: 1000 }],
    ['leaky-bucket', { capacity: 5, leakPerSecond: 1 }],
  ];
  for (const [strategy, opts] of cases) {
    const rl = new RateLimiter(strategy, opts);
    assert.equal(rl.tryConsume('k', 3), true, `${strategy}: should allow`);
    assert.equal(rl.tryConsume('k', 3), false, `${strategy}: should reject when full`);
  }
});

test('RateLimiter unknown strategy throws', () => {
  assert.throws(() => new RateLimiter('invalid-strategy', {}), TypeError);
});

test('RateLimiter keys() returns all active keys', () => {
  const rl = new RateLimiter('fixed-window', { limit: 5, windowMs: 1000 });
  rl.tryConsume('a');
  rl.tryConsume('b');
  rl.tryConsume('c');
  const keys = [...rl.keys()].sort();
  assert.deepEqual(keys, ['a', 'b', 'c']);
});

test('createRateLimiter factory returns RateLimiter', () => {
  const rl = createRateLimiter('token-bucket', { capacity: 10, tokensPerSecond: 5 });
  assert.equal(rl.tryConsume('test', 5), true);
  assert.equal(rl.size, 1);
});

// ─── Async consume paths (waiting) ───────────────────────────

test('SlidingWindow consume waits then resolves', async () => {
  // Use real clock with short window to test async consume path
  const sw = new SlidingWindow({ limit: 3, windowMs: 100 });
  assert.equal(sw.tryConsume(3), true); // fill up
  const start = Date.now();
  await sw.consume(1); // should wait ~100ms for window to slide
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 50, `consume should have waited (elapsed=${elapsed}ms)`);
});

test('SlidingWindow available reflects current estimate', () => {
  const sw = new SlidingWindow({ limit: 10, windowMs: 1000 });
  sw.tryConsume(4);
  assert.equal(sw.available, 6);
  sw.tryConsume(3);
  assert.equal(sw.available, 3);
});

test('FixedWindow consume waits then resolves', async () => {
  const fw = new FixedWindow({ limit: 3, windowMs: 100 });
  assert.equal(fw.tryConsume(3), true); // fill up
  const start = Date.now();
  await fw.consume(1); // should wait for window reset
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 50, `consume should have waited (elapsed=${elapsed}ms)`);
});

test('LeakyBucket add waits then resolves', async () => {
  const lb = new LeakyBucket({ capacity: 3, leakPerSecond: 100 });
  assert.equal(lb.tryAdd(3), true); // fill up
  const start = Date.now();
  await lb.add(1); // should wait ~10ms for 1 unit to leak (100/s)
  const elapsed = Date.now() - start;
  assert.ok(lb.level > 0 && lb.level <= 3);
});

test('LeakyBucket consume alias works like add', async () => {
  const lb = new LeakyBucket({ capacity: 5, leakPerSecond: 100 });
  await lb.consume(2);
  assert.equal(lb.level, 2);
});

// ─── RateLimiter additional coverage ────────────────────────

test('RateLimiter consume() delegates async', async () => {
  const rl = new RateLimiter('token-bucket', { capacity: 5, tokensPerSecond: 1000 });
  rl.tryConsume('k', 5); // exhaust
  const start = Date.now();
  await rl.consume('k', 1); // should wait ~1ms for refill
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, 'should not take too long');
});

test('RateLimiter reset() on missing key is a no-op', () => {
  const rl = new RateLimiter('fixed-window', { limit: 5, windowMs: 1000 });
  rl.tryConsume('a', 2);
  rl.reset('nonexistent'); // should not throw
  assert.equal(rl.tryConsume('a', 3), true); // 'a' still has 3 remaining
});

test('RateLimiter clear() removes all keys', () => {
  const rl = new RateLimiter('fixed-window', { limit: 5, windowMs: 1000 });
  rl.tryConsume('a');
  rl.tryConsume('b');
  assert.equal(rl.size, 2);
  rl.clear();
  assert.equal(rl.size, 0);
});

test('RateLimiter toJSON() serializes all limiters', () => {
  const rl = new RateLimiter('token-bucket', { capacity: 5, tokensPerSecond: 1 });
  rl.tryConsume('user1', 2);
  rl.tryConsume('user2', 1);
  const json = rl.toJSON();
  assert.equal(Object.keys(json).length, 2);
  assert.ok('user1' in json);
  assert.ok('user2' in json);
  // Each value should be a valid limiter state
  assert.ok(json.user1.tokens !== undefined);
  assert.ok(json.user2.tokens !== undefined);
});

// ─── VERSION ─────────────────────────────────────────────────

test('VERSION follows semver format', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(VERSION, pkg.version);
});
