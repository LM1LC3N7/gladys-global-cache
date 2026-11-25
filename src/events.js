// -----------------------------------------------------------------------------
// The rate limit of what is published to Gladys. Pure, clock given by the
// caller (monotonic).
// -----------------------------------------------------------------------------

/** At most `limit` items per sliding minute (monotonic clock). */
export class RateLimiter {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.times = [];
    this.refusedCount = 0;
  }

  take(mono, count = 1) {
    while (this.times.length && (mono - this.times[0] >= this.windowMs || mono < this.times[0])) {
      this.times.shift();
    }
    if (this.times.length + count > this.limit) {
      this.refusedCount += count;
      return false;
    }
    for (let i = 0; i < count; i += 1) this.times.push(mono);
    return true;
  }
}
