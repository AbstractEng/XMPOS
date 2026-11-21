#pragma once
// Fast, exact number conversion for XMP's JSON (json.hpp), the way V8 does it:
//   - shortest(): Grisu3 (Loitsch, "Printing floating-point numbers quickly
//     and accurately with integers", 2010), the fast path of V8's
//     Number.prototype.toString. It gives the shortest digits that read back
//     exactly, the closest of them, or reports that it cannot be sure (about
//     0.5% of doubles); json.hpp then uses its exact search, as V8 then uses
//     its bignum.
//   - parse(): the Eisel-Lemire algorithm (Lemire, "Number parsing at a
//     gigabyte per second", 2021) for decimals of up to 19 significant digits,
//     correctly rounded; anything else is left to strtod.
// The tables both need (powers of ten and five to 64 and 128 bits) are worked
// out once, exactly, with a small big-integer routine, instead of being typed in.
// Only the C library: this builds for WebAssembly too.
#include <math.h>
#include <stdint.h>
#include <string.h>

namespace xmp::numbers {

namespace detail {

// ---- a little exact big-integer arithmetic, for the tables ----
struct Big {
  static constexpr int kWords = 64;  // 2048 bits: 2^1718 (for 5^-342) fits
  uint32_t w[kWords] = {};
  int n = 0;  // words in use
  void set(uint32_t v) {
    memset(w, 0, sizeof w);
    w[0] = v, n = v ? 1 : 0;
  }
  void mul(uint32_t m) {
    uint64_t carry = 0;
    for (int i = 0; i < n; ++i) {
      const uint64_t t = static_cast<uint64_t>(w[i]) * m + carry;
      w[i] = static_cast<uint32_t>(t), carry = t >> 32;
    }
    if (carry) w[n++] = static_cast<uint32_t>(carry);
  }
  // Divides by d (floor), returns the remainder.
  uint32_t div(uint32_t d) {
    uint64_t r = 0;
    for (int i = n - 1; i >= 0; --i) {
      const uint64_t t = (r << 32) | w[i];
      w[i] = static_cast<uint32_t>(t / d), r = t % d;
    }
    while (n && !w[n - 1]) --n;
    return static_cast<uint32_t>(r);
  }
  void shl1() {
    uint32_t carry = 0;
    for (int i = 0; i < n; ++i) {
      const uint32_t next = w[i] >> 31;
      w[i] = (w[i] << 1) | carry, carry = next;
    }
    if (carry) w[n++] = carry;
  }
  void set_pow2(int k) {
    memset(w, 0, sizeof w);
    w[k / 32] = 1u << (k % 32), n = k / 32 + 1;
  }
  int bits() const {
    if (!n) return 0;
    int b = 32;
    while (!(w[n - 1] >> (b - 1))) --b;
    return (n - 1) * 32 + b;
  }
  // The `count` bits from bit `from` (from the bottom) as an integer (count <= 64).
  uint64_t take(int from, int count) const {
    uint64_t out = 0;
    for (int i = count - 1; i >= 0; --i) {
      const int b = from + i;
      out = (out << 1) | (b >= 0 && b / 32 < n ? (w[b / 32] >> (b % 32)) & 1u : 0u);
    }
    return out;
  }
  void add1() {
    for (int i = 0; i < kWords; ++i)
      if (++w[i]) {
        if (i >= n) n = i + 1;
        return;
      }
  }
};

inline int clz64(uint64_t x) { return x ? __builtin_clzll(x) : 64; }
// The full 128-bit product of two 64-bit numbers, also where no 128-bit
// integer type exists (the Live's 32-bit ARM).
inline void multiply_64(uint64_t a, uint64_t b, uint64_t& high, uint64_t& low) {
#if defined(__SIZEOF_INT128__)
  const unsigned __int128 p = static_cast<unsigned __int128>(a) * b;
  high = static_cast<uint64_t>(p >> 64), low = static_cast<uint64_t>(p);
#else
  const uint64_t a_lo = a & 0xFFFFFFFFu, a_hi = a >> 32, b_lo = b & 0xFFFFFFFFu, b_hi = b >> 32;
  const uint64_t ll = a_lo * b_lo, lh = a_lo * b_hi, hl = a_hi * b_lo, hh = a_hi * b_hi;
  const uint64_t middle = (ll >> 32) + (lh & 0xFFFFFFFFu) + (hl & 0xFFFFFFFFu);
  low = (middle << 32) | (ll & 0xFFFFFFFFu);
  high = hh + (lh >> 32) + (hl >> 32) + (middle >> 32);
#endif
}

// ---- Eisel-Lemire's table: 5^q to 128 bits, q in [-342, 308] (as fast_float's) ----
constexpr int kSmallestPower = -342, kLargestPower = 308;
struct Pow5 {
  uint64_t hi[kLargestPower - kSmallestPower + 1], lo[kLargestPower - kSmallestPower + 1];
  Pow5() {
    Big b;
    for (int q = kSmallestPower; q <= kLargestPower; ++q) {
      const int i = q - kSmallestPower;
      if (q >= 0) {
        // 5^q, its most significant bit moved to bit 127, truncated.
        b.set(1);
        for (int k = 0; k < q; ++k) b.mul(5);
        const int top = b.bits();
        hi[i] = b.take(top - 64, 64), lo[i] = b.take(top - 128, 64);
      } else {
        // floor(2^b / 5^-q) + 1, truncated to 128 bits; b as fast_float chooses it.
        Big p;
        p.set(1);
        for (int k = 0; k < -q; ++k) p.mul(5);
        const int z = p.bits();  // the smallest z with 2^z >= 5^-q (a power of five is never a power of two)
        const int power = q >= -27 ? z + 127 : 2 * z + 128;
        b.set_pow2(power);
        for (int k = 0; k < -q; ++k) b.div(5);
        b.add1();
        const int top = b.bits();
        hi[i] = top > 128 ? b.take(top - 64, 64) : b.take(64, 64);
        lo[i] = top > 128 ? b.take(top - 128, 64) : b.take(0, 64);
      }
    }
  }
};
inline const Pow5& pow5() {
  static const Pow5 table;
  return table;
}

// ---- Grisu's cached powers of ten: 10^k to 64 bits, k = -348, -340, ..., 340 ----
constexpr int kCachedPowers = 87, kCachedOffset = 348, kCachedStep = 8;
struct Cached {
  uint64_t f[kCachedPowers];
  int16_t e[kCachedPowers], k[kCachedPowers];
  Cached() {
    Big b;
    for (int i = 0; i < kCachedPowers; ++i) {
      const int dec = -kCachedOffset + i * kCachedStep;
      k[i] = static_cast<int16_t>(dec);
      if (dec >= 0) {
        // round(10^dec / 2^shift) with 64 significant bits.
        b.set(1);
        for (int j = 0; j < dec; ++j) b.mul(10);
        const int top = b.bits(), shift = top - 64;
        uint64_t sig = shift > 0 ? b.take(shift, 64) : b.take(0, 64) << -shift;
        if (shift > 0 && b.take(shift - 1, 1)) ++sig;  // round half up (no exact ties occur)
        if (!sig) sig = 1ull << 63;
        f[i] = sig, e[i] = static_cast<int16_t>(shift);
      } else {
        // round(2^m / 10^-dec) with 64 significant bits: floor of 2^(m+1)/10^-dec, then halve rounding up.
        const int m = 64 + static_cast<int>(ceil(-dec * 3.3219280948873626)) + 1;
        b.set_pow2(m + 1);
        for (int j = 0; j < -dec; ++j) b.div(10);
        const int top = b.bits(), extra = top - 65;  // keep 65 bits, then round to 64
        uint64_t sig = b.take(extra + 1, 64);
        if (b.take(extra, 1)) ++sig;
        int exponent = -(m + 1) + extra + 1;
        if (!sig) sig = 1ull << 63, ++exponent;
        f[i] = sig, e[i] = static_cast<int16_t>(exponent);
      }
    }
  }
};
inline const Cached& cached() {
  static const Cached table;
  return table;
}

struct DiyFp {
  uint64_t f = 0;
  int e = 0;
};
inline DiyFp times(DiyFp a, DiyFp b) {
  const uint64_t m32 = 0xFFFFFFFFu;
  const uint64_t ah = a.f >> 32, al = a.f & m32, bh = b.f >> 32, bl = b.f & m32;
  const uint64_t ac = ah * bh, bc = al * bh, ad = ah * bl, bd = al * bl;
  uint64_t tmp = (bd >> 32) + (ad & m32) + (bc & m32);
  tmp += 1u << 31;  // round
  return {ac + (ad >> 32) + (bc >> 32) + (tmp >> 32), a.e + b.e + 64};
}
inline DiyFp normalize(DiyFp v) {
  const int s = clz64(v.f);
  return {v.f << s, v.e - s};
}

inline bool round_weed(char* buffer, int length, uint64_t distance_too_high_w, uint64_t unsafe_interval, uint64_t rest,
                       uint64_t ten_kappa, uint64_t unit) {
  const uint64_t small_distance = distance_too_high_w - unit, big_distance = distance_too_high_w + unit;
  while (rest < small_distance && unsafe_interval - rest >= ten_kappa &&
         (rest + ten_kappa < small_distance || small_distance - rest >= rest + ten_kappa - small_distance)) {
    buffer[length - 1]--;
    rest += ten_kappa;
  }
  if (rest < big_distance && unsafe_interval - rest >= ten_kappa &&
      (rest + ten_kappa < big_distance || big_distance - rest > rest + ten_kappa - big_distance))
    return false;
  return 2 * unit <= rest && rest <= unsafe_interval - 4 * unit;
}

inline bool digit_gen(DiyFp low, DiyFp w, DiyFp high, char* buffer, int& length, int& kappa) {
  static const uint32_t kSmallPowers[] = {0, 1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000};
  uint64_t unit = 1;
  const DiyFp too_low{low.f - unit, low.e}, too_high{high.f + unit, high.e};
  DiyFp unsafe_interval{too_high.f - too_low.f, too_high.e};
  const DiyFp one{1ull << -w.e, w.e};
  uint32_t integrals = static_cast<uint32_t>(too_high.f >> -one.e);
  uint64_t fractionals = too_high.f & (one.f - 1);
  // The biggest power of ten not above `integrals`.
  const int bits = 64 - (-one.e);
  int guess = ((bits + 1) * 1233 >> 12) + 1;
  if (guess > 10) guess = 10;
  if (integrals < kSmallPowers[guess]) --guess;
  uint32_t divisor = kSmallPowers[guess];
  kappa = guess;
  length = 0;
  while (kappa > 0) {
    const uint32_t digit = integrals / divisor;
    buffer[length++] = static_cast<char>('0' + digit);
    integrals %= divisor;
    --kappa;
    const uint64_t rest = (static_cast<uint64_t>(integrals) << -one.e) + fractionals;
    if (rest < unsafe_interval.f)
      return round_weed(buffer, length, too_high.f - w.f, unsafe_interval.f, rest, static_cast<uint64_t>(divisor) << -one.e,
                        unit);
    divisor /= 10;
  }
  for (;;) {
    fractionals *= 10, unit *= 10, unsafe_interval.f *= 10;
    const int digit = static_cast<int>(fractionals >> -one.e);
    buffer[length++] = static_cast<char>('0' + digit);
    fractionals &= one.f - 1;
    --kappa;
    if (fractionals < unsafe_interval.f)
      return round_weed(buffer, length, (too_high.f - w.f) * unit, unsafe_interval.f, fractionals, one.f, unit);
  }
}

}  // namespace detail

// The shortest digits of a positive finite double that read back exactly (the
// closest such when several are as short): `count` digits, the value being
// 0.d1d2... x 10^`point`. False when Grisu3 cannot be sure; then use an exact method.
inline bool shortest(double v, char digits[18], int& count, int& point) {
  using namespace detail;
  if (!(v > 0) || !isfinite(v)) return false;
  uint64_t bits;
  memcpy(&bits, &v, 8);
  const uint64_t fraction = bits & ((1ull << 52) - 1);
  const int biased = static_cast<int>(bits >> 52 & 0x7FF);
  DiyFp f;
  if (biased) f = {fraction | (1ull << 52), biased - 0x3FF - 52};
  else f = {fraction, -0x3FF - 52 + 1};
  const DiyFp w = normalize(f);
  // The boundaries halfway to the neighbouring doubles.
  DiyFp plus = normalize({(f.f << 1) + 1, f.e - 1}), minus;
  const bool lower_closer = fraction == 0 && biased > 1;
  minus = lower_closer ? DiyFp{(f.f << 2) - 1, f.e - 2} : DiyFp{(f.f << 1) - 1, f.e - 1};
  minus.f <<= minus.e - plus.e, minus.e = plus.e;
  // A cached power of ten that brings w's exponent into [-60, -32].
  const int min_exponent = -60 - (w.e + 64);
  const double k = ceil((min_exponent + 64 - 1) * 0.30102999566398114);
  const int index = (kCachedOffset + static_cast<int>(k) - 1) / kCachedStep + 1;
  if (index < 0 || index >= kCachedPowers) return false;
  const Cached& c = cached();
  const DiyFp ten_mk{c.f[index], c.e[index]};
  const int mk = c.k[index];
  int kappa = 0;
  char buffer[24];
  int length = 0;
  if (!digit_gen(times(minus, ten_mk), times(w, ten_mk), times(plus, ten_mk), buffer, length, kappa)) return false;
  if (length < 1 || length > 17) return false;
  memcpy(digits, buffer, static_cast<size_t>(length));
  count = length;
  point = length + (-mk + kappa);
  return true;
}

// A decimal w x 10^q (w < 10^19, at most 19 significant digits) correctly
// rounded to a double. False when the algorithm declines; then use strtod.
inline bool parse(uint64_t w, int q, bool negative, double& out) {
  using namespace detail;
  if (w == 0 || q < kSmallestPower) {
    out = negative ? -0.0 : 0.0;
    return true;
  }
  if (q > kLargestPower) return false;  // infinity: strtod says so
  // Clinger's fast path: exact for small w and q.
  static const double kPow10[] = {1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
                                  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};
  if (w <= (1ull << 53) && q >= -22 && q <= 22) {
    double d = static_cast<double>(w);
    d = q < 0 ? d / kPow10[-q] : d * kPow10[q];
    out = negative ? -d : d;
    return true;
  }
  const Pow5& t = pow5();
  const int i = q - kSmallestPower;
  const int lz = clz64(w);
  w <<= lz;
  uint64_t high = 0, low = 0;
  multiply_64(w, t.hi[i], high, low);
  const uint64_t precision_mask = 0xFFFFFFFFFFFFFFFFull >> 55;
  if ((high & precision_mask) == precision_mask) {
    uint64_t second_high = 0, second_low = 0;
    multiply_64(w, t.lo[i], second_high, second_low);
    low += second_high;
    if (second_high > low) ++high;
    if ((high & precision_mask) == precision_mask && low + 1 == 0) return false;  // cannot be sure
  }
  const int upperbit = static_cast<int>(high >> 63);
  uint64_t mantissa = high >> (upperbit + 64 - 52 - 3);
  int power2 = (((152170 + 65536) * q) >> 16) + 63 + upperbit - lz + 1023;
  if (power2 <= 0) {  // subnormal
    if (-power2 + 1 >= 64) {
      out = negative ? -0.0 : 0.0;
      return true;
    }
    mantissa >>= -power2 + 1;
    mantissa += mantissa & 1;
    mantissa >>= 1;
    power2 = mantissa < (1ull << 52) ? 0 : 1;
  } else {
    // Exactly halfway: round to even.
    if (low <= 1 && q >= -4 && q <= 23 && (mantissa & 3) == 1 && (mantissa << (upperbit + 64 - 52 - 3)) == high)
      mantissa &= ~1ull;
    mantissa += mantissa & 1;
    mantissa >>= 1;
    if (mantissa >= (2ull << 52)) mantissa = 1ull << 52, ++power2;
    mantissa &= ~(1ull << 52);
    if (power2 >= 0x7FF) return false;  // overflow: strtod says infinity
  }
  const uint64_t bits = (static_cast<uint64_t>(power2) << 52) | mantissa | (negative ? 1ull << 63 : 0);
  memcpy(&out, &bits, 8);
  return true;
}

}  // namespace xmp::numbers
