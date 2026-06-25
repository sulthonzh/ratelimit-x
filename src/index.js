/**
 * ratelimit-x — Zero-dependency rate limiting for Node.js
 *
 * Four algorithms:
 *   TokenBucket    — continuous refill, allows bursts up to capacity
 *   SlidingWindow  — weighted overlap of current + previous windows (smooth)
 *   FixedWindow    — hard reset at window boundaries (simple, can burst at edges)
 *   LeakyBucket    — requests leak out at fixed rate (smoothing / queue-like)
 *
 * Keyed RateLimiter wrapper for per-user / per-IP limiting.
 * MIT License — Copyright (c) 2026 sulthonzh
 */

export const VERSION = '1.1.0';

// ─── Token Bucket ────────────────────────────────────────────

export class TokenBucket {
  constructor({ capacity, tokensPerSecond, tokens, timeProvider } = {}) {
    if (!capacity || capacity <= 0) throw new TypeError('capacity must be a positive number');
    if (!tokensPerSecond || tokensPerSecond <= 0) throw new TypeError('tokensPerSecond must be a positive number');
    this.capacity = capacity;
    this.tokensPerSecond = tokensPerSecond;
    this.tokens = tokens ?? capacity;
    if (this.tokens < 0) throw new RangeError('initial tokens cannot be negative');
    if (this.tokens > capacity) throw new RangeError('initial tokens cannot exceed capacity');
    this._now = timeProvider ?? (() => Date.now());
    this.lastRefill = this._now();
  }

  _refill() {
    const now = this._now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.tokensPerSecond);
      this.lastRefill = now;
    }
  }

  tryConsume(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    this._refill();
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }

  async consume(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    if (amount > this.capacity) throw new RangeError('amount exceeds capacity');
    for (;;) {
      this._refill();
      if (this.tokens >= amount) {
        this.tokens -= amount;
        return;
      }
      const deficit = amount - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.tokensPerSecond) * 1000));
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  get available() {
    this._refill();
    return this.tokens;
  }

  reset() {
    this.tokens = this.capacity;
    this.lastRefill = this._now();
  }

  toJSON() {
    this._refill();
    return {
      strategy: 'token-bucket',
      capacity: this.capacity,
      tokensPerSecond: this.tokensPerSecond,
      tokens: this.tokens,
      lastRefill: this.lastRefill,
    };
  }

  static fromJSON(json) {
    const tb = new TokenBucket({
      capacity: json.capacity,
      tokensPerSecond: json.tokensPerSecond,
      tokens: json.tokens,
    });
    tb.lastRefill = json.lastRefill;
    return tb;
  }
}

// ─── Sliding Window ──────────────────────────────────────────

export class SlidingWindow {
  constructor({ limit, windowMs, timeProvider } = {}) {
    if (!limit || limit <= 0) throw new TypeError('limit must be a positive number');
    if (!windowMs || windowMs <= 0) throw new TypeError('windowMs must be a positive number');
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = timeProvider ?? (() => Date.now());
    const now = this._now();
    this.windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    this.prevCount = 0;
    this.currCount = 0;
  }

  _slide() {
    const now = this._now();
    const currentStart = Math.floor(now / this.windowMs) * this.windowMs;
    if (currentStart > this.windowStart) {
      const passed = Math.floor((currentStart - this.windowStart) / this.windowMs);
      if (passed >= 2) {
        this.prevCount = 0;
        this.currCount = 0;
      } else {
        this.prevCount = this.currCount;
        this.currCount = 0;
      }
      this.windowStart = currentStart;
    }
  }

  _estimate() {
    const now = this._now();
    const elapsed = now - this.windowStart;
    const weight = Math.max(0, 1 - elapsed / this.windowMs);
    return this.prevCount * weight + this.currCount;
  }

  tryConsume(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    this._slide();
    if (this._estimate() + amount <= this.limit) {
      this.currCount += amount;
      return true;
    }
    return false;
  }

  async consume(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    for (;;) {
      this._slide();
      if (this._estimate() + amount <= this.limit) {
        this.currCount += amount;
        return;
      }
      const now = this._now();
      const remaining = this.windowMs - (now - this.windowStart);
      const waitMs = Math.max(1, Math.min(remaining + 1, 2000));
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  get available() {
    this._slide();
    return Math.max(0, Math.floor(this.limit - this._estimate()));
  }

  reset() {
    const now = this._now();
    this.windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    this.prevCount = 0;
    this.currCount = 0;
  }

  toJSON() {
    this._slide();
    return {
      strategy: 'sliding-window',
      limit: this.limit,
      windowMs: this.windowMs,
      windowStart: this.windowStart,
      prevCount: this.prevCount,
      currCount: this.currCount,
    };
  }

  static fromJSON(json) {
    const sw = new SlidingWindow({ limit: json.limit, windowMs: json.windowMs });
    sw.windowStart = json.windowStart;
    sw.prevCount = json.prevCount;
    sw.currCount = json.currCount;
    return sw;
  }
}

// ─── Fixed Window ────────────────────────────────────────────

export class FixedWindow {
  constructor({ limit, windowMs, timeProvider } = {}) {
    if (!limit || limit <= 0) throw new TypeError('limit must be a positive number');
    if (!windowMs || windowMs <= 0) throw new TypeError('windowMs must be a positive number');
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = timeProvider ?? (() => Date.now());
    const now = this._now();
    this.windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    this.count = 0;
  }

  _slide() {
    const now = this._now();
    const currentStart = Math.floor(now / this.windowMs) * this.windowMs;
    if (currentStart > this.windowStart) {
      this.windowStart = currentStart;
      this.count = 0;
    }
  }

  tryConsume(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    this._slide();
    if (this.count + amount <= this.limit) {
      this.count += amount;
      return true;
    }
    return false;
  }

  async consume(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    for (;;) {
      this._slide();
      if (this.count + amount <= this.limit) {
        this.count += amount;
        return;
      }
      const now = this._now();
      const remaining = this.windowMs - (now - this.windowStart);
      const waitMs = Math.max(1, remaining + 1);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  get available() {
    this._slide();
    return Math.max(0, this.limit - this.count);
  }

  reset() {
    const now = this._now();
    this.windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    this.count = 0;
  }

  toJSON() {
    this._slide();
    return {
      strategy: 'fixed-window',
      limit: this.limit,
      windowMs: this.windowMs,
      windowStart: this.windowStart,
      count: this.count,
    };
  }

  static fromJSON(json) {
    const fw = new FixedWindow({ limit: json.limit, windowMs: json.windowMs });
    fw.windowStart = json.windowStart;
    fw.count = json.count;
    return fw;
  }
}

// ─── Leaky Bucket ────────────────────────────────────────────

export class LeakyBucket {
  constructor({ capacity, leakPerSecond, level, timeProvider } = {}) {
    if (!capacity || capacity <= 0) throw new TypeError('capacity must be a positive number');
    if (!leakPerSecond || leakPerSecond <= 0) throw new TypeError('leakPerSecond must be a positive number');
    this.capacity = capacity;
    this.leakPerSecond = leakPerSecond;
    this.level = level ?? 0;
    if (this.level < 0) throw new RangeError('initial level cannot be negative');
    if (this.level > capacity) throw new RangeError('initial level cannot exceed capacity');
    this._now = timeProvider ?? (() => Date.now());
    this.lastLeak = this._now();
  }

  _leak() {
    const now = this._now();
    const elapsed = now - this.lastLeak;
    if (elapsed > 0) {
      const leaked = (elapsed / 1000) * this.leakPerSecond;
      this.level = Math.max(0, this.level - leaked);
      this.lastLeak = now;
    }
  }

  tryAdd(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    this._leak();
    if (this.level + amount <= this.capacity) {
      this.level += amount;
      return true;
    }
    return false;
  }

  async add(amount = 1) {
    if (amount <= 0) throw new TypeError('amount must be positive');
    if (amount > this.capacity) throw new RangeError('amount exceeds capacity');
    for (;;) {
      this._leak();
      if (this.level + amount <= this.capacity) {
        this.level += amount;
        return;
      }
      const space = this.capacity - this.level;
      const needed = amount - space;
      const waitMs = Math.max(1, Math.ceil((needed / this.leakPerSecond) * 1000));
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  // Unified aliases (so RateLimiter can call tryConsume/consume on any strategy)
  tryConsume(amount = 1) { return this.tryAdd(amount); }
  async consume(amount = 1) { return this.add(amount); }

  get available() {
    this._leak();
    return this.capacity - this.level;
  }

  reset() {
    this.level = 0;
    this.lastLeak = this._now();
  }

  toJSON() {
    this._leak();
    return {
      strategy: 'leaky-bucket',
      capacity: this.capacity,
      leakPerSecond: this.leakPerSecond,
      level: this.level,
      lastLeak: this.lastLeak,
    };
  }

  static fromJSON(json) {
    const lb = new LeakyBucket({
      capacity: json.capacity,
      leakPerSecond: json.leakPerSecond,
      level: json.level,
    });
    lb.lastLeak = json.lastLeak;
    return lb;
  }
}

// ─── Keyed Rate Limiter ──────────────────────────────────────

const STRATEGIES = {
  'token-bucket': TokenBucket,
  'sliding-window': SlidingWindow,
  'fixed-window': FixedWindow,
  'leaky-bucket': LeakyBucket,
};

export class RateLimiter {
  constructor(strategy, options = {}) {
    const Cls = STRATEGIES[strategy] ?? strategy;
    if (typeof Cls !== 'function') {
      throw new TypeError(`Unknown strategy: ${strategy}. Available: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    this._StrategyClass = Cls;
    this.options = options;
    this.limiters = new Map();
  }

  get(key) {
    if (!this.limiters.has(key)) {
      this.limiters.set(key, new this._StrategyClass({ ...this.options }));
    }
    return this.limiters.get(key);
  }

  tryConsume(key, amount = 1) {
    return this.get(key).tryConsume(amount);
  }

  async consume(key, amount = 1) {
    return this.get(key).consume(amount);
  }

  reset(key) {
    if (key === undefined) {
      for (const l of this.limiters.values()) l.reset();
    } else {
      this.limiters.get(key)?.reset();
    }
  }

  delete(key) {
    return this.limiters.delete(key);
  }

  clear() {
    this.limiters.clear();
  }

  get size() {
    return this.limiters.size;
  }

  keys() {
    return this.limiters.keys();
  }

  toJSON() {
    const result = {};
    for (const [key, limiter] of this.limiters) {
      result[key] = limiter.toJSON();
    }
    return result;
  }
}

// ─── Factory ─────────────────────────────────────────────────

export function createRateLimiter(strategy, options) {
  return new RateLimiter(strategy, options);
}
