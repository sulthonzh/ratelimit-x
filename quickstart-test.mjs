import { TokenBucket } from './index.js';

// 10 requests max, refills 2 per second
const limiter = new TokenBucket({ capacity: 10, tokensPerSecond: 2 });

console.log('Test 1: Should consume token');
if (limiter.tryConsume()) {
  console.log('✅ Request handled');
} else {
  console.log('❌ Rate limited');
}

console.log('Available tokens:', limiter.available);

console.log('\nTest 2: Should consume another token');
if (limiter.tryConsume()) {
  console.log('✅ Request handled');
} else {
  console.log('❌ Rate limited');
}

console.log('Available tokens:', limiter.available);