# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-15

### Added
- TokenBucket algorithm — continuous refill, allows bursts up to capacity
- SlidingWindow algorithm — weighted overlap of current + previous windows (smooth)
- FixedWindow algorithm — hard reset at window boundaries (simple, can burst at edges)
- LeakyBucket algorithm — requests leak out at fixed rate (smoothing / queue-like)
- RateLimiter wrapper for per-user / per-IP limiting
- Serialization support — toJSON() / fromJSON() for all algorithms
- Custom timeProvider support for testing
- Factory function: createRateLimiter()
- VERSION constant export
- Comprehensive test suite (40 tests, 100% pass rate)
- Zero-dependency ESM package