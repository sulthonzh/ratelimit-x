# ratelimit-x

Zero-dependency rate limiting for Node.js. 42 tests, 100% pass rate, Token Bucket, Sliding Window, Fixed Window, and Leaky Bucket algorithms — all in one tiny package with zero dependencies.

## Install

```bash
npm install ratelimit-x
```

## Why?

Every rate limiting library I found was either:
- Tied to Express/Fastify (I just want the algorithm)
- A single strategy (now I need 3 packages)
- Bloated with dependencies

`ratelimit-x` ships 4 algorithms in one tiny package. Zero deps. ESM. Done.

## Quick Start

```javascript
import { TokenBucket } from 'ratelimit-x';

// 10 requests max, refills 2 per second
const limiter = new TokenBucket({ capacity: 10, tokensPerSecond: 2 });

if (limiter.tryConsume()) {
  handleRequest();
} else {
  reply(429, 'Too many requests');
}
```

## Algorithms

### TokenBucket

Tokens accumulate continuously at `tokensPerSecond` up to `capacity`. Each request consumes tokens. Allows controlled bursts.

```javascript
const tb = new TokenBucket({
  capacity: 10,          // max tokens (burst size)
  tokensPerSecond: 2,    // refill rate
  tokens: 10,            // optional: start with fewer
});

tb.tryConsume(1);        // → true (non-blocking)
tb.available;            // → 9
await tb.consume(1);     // blocks until tokens available
```

**Best for:** API rate limiting where occasional bursts are OK.

### SlidingWindow

Tracks requests in current + previous time windows, estimates usage with a weighted average. Smoother than fixed window, no burst-at-boundary problem.

```javascript
const sw = new SlidingWindow({
  limit: 100,     // max requests
  windowMs: 60000 // per minute
});

sw.tryConsume(1); // → true
sw.available;     // → 99
```

**Best for:** When you need smooth, predictable limiting without edge bursts.

### FixedWindow

Simple counter that resets at window boundaries. Easiest to reason about, but allows 2× limit at window edges.

```javascript
const fw = new FixedWindow({
  limit: 100,
  windowMs: 60000
});

fw.tryConsume(1); // → true
fw.available;     // → 99
```

**Best for:** Simple use cases where precision isn't critical.

### LeakyBucket

Requests "fill" the bucket and leak out at a steady rate. Smooths bursty traffic into a steady stream.

```javascript
const lb = new LeakyBucket({
  capacity: 10,        // max queued
  leakPerSecond: 5,    // processing rate
});

lb.tryAdd(1);          // → true
lb.available;          // → 9
```

**Best for:** Traffic smoothing, queue-based processing, producer-consumer scenarios.

## Per-Key Limiting (RateLimiter)

Want to rate limit per user, per IP, per API key? Use `RateLimiter`:

```javascript
import { RateLimiter } from 'ratelimit-x';

const api = new RateLimiter('token-bucket', {
  capacity: 100,
  tokensPerSecond: 10,
});

// Each key gets its own limiter, created on demand
api.tryConsume('user-123');  // → true
api.tryConsume('user-456');  // → true (separate bucket)
api.tryConsume('user-123');  // depends on user-123's remaining tokens

api.size;   // → 2 (two active keys)
api.reset('user-123');       // reset one user
api.reset();                 // reset all
api.delete('user-456');      // remove a key entirely
```

## Blocking (Async)

Need to wait instead of rejecting? Use `consume()`:

```javascript
const tb = new TokenBucket({ capacity: 5, tokensPerSecond: 1 });

// Blocks until 1 token is available
await tb.consume(1);
// → proceeds when allowed

// For per-key:
const rl = new RateLimiter('sliding-window', { limit: 10, windowMs: 1000 });
await rl.consume('user-1', 1); // blocks until allowed
```

## Serialization

All algorithms support `toJSON()` / `fromJSON()` for persistence (Redis, database, etc.):

```javascript
const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 2 });
tb.tryConsume(3);

const saved = tb.toJSON();
// Store saved somewhere...
const restored = TokenBucket.fromJSON(saved);
```

## Testing with Custom Time

Pass a `timeProvider` function to control time in tests:

```javascript
let t = 1000;
const clock = () => t;
const advance = (ms) => { t += ms; };

const tb = new TokenBucket({ capacity: 10, tokensPerSecond: 2, timeProvider: clock });
tb.tryConsume(10);
advance(1000); // fast-forward 1 second
tb.available;  // → 2
```

## API Reference

### TokenBucket

| Option | Type | Description |
|--------|------|-------------|
| `capacity` | number | Max tokens (burst capacity) |
| `tokensPerSecond` | number | Refill rate |
| `tokens` | number? | Initial tokens (default: `capacity`) |
| `timeProvider` | function? | Custom clock for testing |

### SlidingWindow / FixedWindow

| Option | Type | Description |
|--------|------|-------------|
| `limit` | number | Max requests per window |
| `windowMs` | number | Window size in milliseconds |
| `timeProvider` | function? | Custom clock |

### LeakyBucket

| Option | Type | Description |
|--------|------|-------------|
| `capacity` | number | Max requests in bucket |
| `leakPerSecond` | number | Drain rate |
| `level` | number? | Initial fill level (default: 0) |
| `timeProvider` | function? | Custom clock |

### RateLimiter

```javascript
new RateLimiter(strategy, options, timeProvider?)
```

| Strategy | Options |
|----------|---------|
| `token-bucket` | `capacity`, `tokensPerSecond`, `tokens?` |
| `sliding-window` | `limit`, `windowMs` |
| `fixed-window` | `limit`, `windowMs` |
| `leaky-bucket` | `capacity`, `leakPerSecond`, `level?` |

**Methods:**
- `tryConsume(key, amount?)` → boolean
- `consume(key, amount?)` → Promise<void>
- `available(key)` → number
- `reset(key?)` → void
- `delete(key)` → void
- `keys()` → Iterator
- `size` → number

**Factory:** `createRateLimiter(strategy, options, timeProvider?)` — same as `new RateLimiter(...)`.

## Real-World Examples

### 1. API Gateway Per-User Rate Limiting

```javascript
import { RateLimiter } from 'ratelimit-x';

const apiLimiter = new RateLimiter('token-bucket', {
  capacity: 100,
  tokensPerSecond: 10,
});

async function handleRequest(req, res) {
  const userId = req.headers['x-user-id'];

  if (!apiLimiter.tryConsume(userId, 1)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Process request
  return res.json({ data: 'Success' });
}
```

### 2. Email Sending with Leaky Bucket

```javascript
import { LeakyBucket } from 'ratelimit-x';

const emailQueue = new LeakyBucket({
  capacity: 50,        // Queue up to 50 emails
  leakPerSecond: 10,   // Send 10 emails per second
});

async function sendEmail(to, subject, body) {
  if (!emailQueue.tryAdd(1)) {
    throw new Error('Email queue full, try again later');
  }

  await emailProvider.send({ to, subject, body });
}
```

### 3. Distributed System with Redis Persistence

```javascript
import { SlidingWindow } from 'ratelimit-x';
import { redisGet, redisSet } from './redis.js';

async function rateLimit(service, endpoint) {
  const key = `ratelimit:${service}:${endpoint}`;
  const saved = await redisGet(key);

  let limiter;
  if (saved) {
    limiter = SlidingWindow.fromJSON(JSON.parse(saved));
  } else {
    limiter = new SlidingWindow({ limit: 1000, windowMs: 60000 });
  }

  const allowed = limiter.tryConsume();
  await redisSet(key, JSON.stringify(limiter.toJSON()), 60);

  return allowed;
}
```

## Comparison

| Library | Algorithms | Deps | Size | Node 18+ | Serialization |
|---------|-----------|------|------|----------|---------------|
| **ratelimit-x** | 4 | 0 | ~4KB | ✅ | ✅ |
| [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible) | 2 | 0 | ~12KB | ✅ | ✅ |
| [bottleneck](https://github.com/SGrondin/bottleneck) | 1 | 2 | ~25KB | ✅ | ❌ |
| [express-rate-limit](https://github.com/nfriedly/express-rate-limit) | 1 | 2 | ~15KB | ✅ | ✅ |

**Why ratelimit-x?**
- 4 algorithms in one package (others ship 1-2)
- Zero dependencies (bottleneck has 2, express-rate-limit has 2)
- Smallest footprint (~4KB vs 12-25KB)
- Full serialization support (Redis-ready)
- Pure ESM, no bundling required

## License

MIT — Copyright (c) 2026 sulthonzh

## VERSION

```javascript
import { VERSION } from 'ratelimit-x';
console.log(VERSION); // '1.1.0'
```