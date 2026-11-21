#pragma once
// JSON for XMP's C++ core, matching JavaScript's JSON.parse and JSON.stringify
// so projects round-trip byte for byte between the browser and the Live:
//   - parse: RFC 8259 as JSON.parse accepts it; numbers correctly rounded;
//     a repeated key keeps its first position and its last value; \u escapes
//     including lone surrogates (kept as WTF-8);
//   - object key order as JavaScript keeps it: array-index keys ("0", "17")
//     first in ascending order, then the rest in insertion order;
//   - stringify: JavaScript's shortest number text (Number.prototype.toString),
//     -0 as 0, non-finite numbers as null, and JSON.stringify's escapes,
//     compact or indented.
// Bounded: nesting depth is limited; callers preflight sizes first (project.hpp).
#include <math.h>
#include <stdio.h>

#include "xmp/base.hpp"
#include "xmp/numbers.hpp"

namespace xmp::json {

constexpr int32_t kMaxDepth = 64;

struct Member;
// An array's or object's contents, shared by the copies of a value until one
// of them changes it (copy on write). Copying a project is then cheap however
// much sample audio it holds, and an edit copies only what it changes. The
// count is atomic: a copy may be read on another thread (the Live's saver)
// while the original is edited.
template <class T>
struct Shared {
  int32_t refs = 1;
  T data;
};
template <class T>
inline Shared<T>* share(Shared<T>* p) {
  if (p) __atomic_add_fetch(&p->refs, 1, __ATOMIC_RELAXED);
  return p;
}
template <class T>
inline void unshare(Shared<T>* p) {
  if (p && __atomic_sub_fetch(&p->refs, 1, __ATOMIC_ACQ_REL) == 0) {
    p->~Shared<T>();
    free(p);
  }
}
// `p` as this value's own: allocated if missing, copied if shared.
template <class T>
inline T& own(Shared<T>*& p) {
  if (!p) {
    p = new (checked_alloc(sizeof(Shared<T>))) Shared<T>();
  } else if (__atomic_load_n(&p->refs, __ATOMIC_ACQUIRE) > 1) {
    Shared<T>* copy = new (checked_alloc(sizeof(Shared<T>))) Shared<T>();
    copy->data = p->data;
    unshare(p);
    p = copy;
  }
  return p->data;
}

class Value {
 public:
  enum Kind : uint8_t { null, boolean, number, string, array, object };

  Value() = default;
  Value(const Value& o)
      : kind_(o.kind_), bool_(o.bool_), number_(o.number_), string_(o.string_), items_(share(o.items_)),
        members_(share(o.members_)) {}
  Value(Value&& o) noexcept
      : kind_(o.kind_), bool_(o.bool_), number_(o.number_), string_(xmp::move(o.string_)), items_(o.items_),
        members_(o.members_) {
    o.items_ = nullptr, o.members_ = nullptr, o.kind_ = null;
  }
  Value& operator=(const Value& o) {
    if (this == &o) return *this;
    Shared<Vec<Value>>* items = share(o.items_);
    Shared<Vec<Member>>* members = share(o.members_);
    unshare(items_), unshare(members_);
    kind_ = o.kind_, bool_ = o.bool_, number_ = o.number_, string_ = o.string_, items_ = items, members_ = members;
    return *this;
  }
  Value& operator=(Value&& o) noexcept {
    if (this == &o) return *this;
    unshare(items_), unshare(members_);
    kind_ = o.kind_, bool_ = o.bool_, number_ = o.number_, string_ = xmp::move(o.string_);
    items_ = o.items_, members_ = o.members_;
    o.items_ = nullptr, o.members_ = nullptr, o.kind_ = null;
    return *this;
  }
  ~Value() { unshare(items_), unshare(members_); }
  static Value of(bool b) {
    Value v;
    v.kind_ = boolean, v.bool_ = b;
    return v;
  }
  static Value of(double n) {
    Value v;
    v.kind_ = number, v.number_ = n;
    return v;
  }
  static Value of(Str s) {
    Value v;
    v.kind_ = string, v.string_ = xmp::move(s);
    return v;
  }
  static Value of(const char* s) { return of(Str(s)); }
  static Value new_array() {
    Value v;
    v.kind_ = array;
    return v;
  }
  static Value new_object() {
    Value v;
    v.kind_ = object;
    return v;
  }

  Kind kind() const { return kind_; }
  bool is_null() const { return kind_ == null; }
  bool is_bool() const { return kind_ == boolean; }
  bool is_number() const { return kind_ == number; }
  bool is_string() const { return kind_ == string; }
  bool is_array() const { return kind_ == array; }
  bool is_object() const { return kind_ == object; }
  bool as_bool() const { return bool_; }
  double as_number() const { return number_; }
  const Str& as_string() const { return string_; }

  // Arrays. The non-const accessors make the contents this value's own first:
  // a reference from them must not be kept across a copy of the value, or of
  // anything holding it, and then written through.
  Vec<Value>& items() { return own(items_); }
  const Vec<Value>& items() const { return items_ ? items_->data : empty_items(); }
  Value& push(Value v) { return own(items_).push(xmp::move(v)); }
  // Whether two values share their array contents (a copy not yet changed).
  bool shares_items(const Value& o) const { return items_ && items_ == o.items_; }

  // Objects.
  const Vec<Member>& members() const { return members_ ? members_->data : empty_members(); }
  Vec<Member>& members() { return own(members_); }
  const Value* get(const char* key) const;
  Value* get(const char* key);
  bool has(const char* key) const { return get(key) != nullptr; }
  // Sets a key as JavaScript would: an existing key keeps its place.
  Value& set(const Str& key, Value v);
  bool remove(const char* key);

 private:
  Kind kind_ = null;
  bool bool_ = false;
  double number_ = 0;
  Str string_;
  Shared<Vec<Value>>* items_ = nullptr;
  Shared<Vec<Member>>* members_ = nullptr;
  static const Vec<Value>& empty_items() {
    static const Vec<Value> none;
    return none;
  }
  static const Vec<Member>& empty_members();
};

struct Member {
  Str key;
  Value value;
};
inline const Vec<Member>& Value::empty_members() {
  static const Vec<Member> none;
  return none;
}

// A canonical array index ("0".."4294967294"), which JavaScript orders first.
inline bool array_index(const Str& k, uint32_t& out) {
  if (k.empty() || k.size() > 10 || (k[0] == '0' && k.size() > 1)) return false;
  uint64_t v = 0;
  for (size_t i = 0; i < k.size(); ++i) {
    if (k[i] < '0' || k[i] > '9') return false;
    v = v * 10 + static_cast<uint64_t>(k[i] - '0');
  }
  if (v >= 4294967295ULL) return false;
  out = static_cast<uint32_t>(v);
  return true;
}

inline const Value* Value::get(const char* key) const {
  for (const auto& m : members())
    if (m.key == key) return &m.value;
  return nullptr;
}
inline Value* Value::get(const char* key) {
  if (!members_) return nullptr;
  for (auto& m : members())
    if (m.key == key) return &m.value;
  return nullptr;
}
inline Value& Value::set(const Str& key, Value v) {
  Vec<Member>& members_ = members();
  for (auto& m : members_)
    if (m.key == key) return m.value = xmp::move(v);
  uint32_t index = 0;
  int32_t at = members_.size();
  if (array_index(key, index)) {
    at = 0;
    uint32_t other = 0;
    while (at < members_.size() && array_index(members_[at].key, other) && other < index) ++at;
  }
  members_.insert(at, Member{key, xmp::move(v)});
  return members_[at].value;
}
inline bool Value::remove(const char* key) {
  if (!members_) return false;
  Vec<Member>& members_ = members();
  for (int32_t i = 0; i < members_.size(); ++i)
    if (members_[i].key == key) {
      members_.erase(i);
      return true;
    }
  return false;
}

// ---- reading ----
struct ParseResult {
  bool ok = false;
  Value value;
  Str error;
};

namespace detail {
struct Reader {
  const char* p;
  const char* end;
  Str error;

  bool fail(const char* message) {
    if (error.empty()) error = message;
    return false;
  }
  void space() {
    while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) ++p;
  }
  static void utf8(Str& out, uint32_t c) {
    char b[4];
    size_t n = 0;
    if (c < 0x80)
      b[n++] = static_cast<char>(c);
    else if (c < 0x800)
      b[n++] = static_cast<char>(0xC0 | (c >> 6)), b[n++] = static_cast<char>(0x80 | (c & 0x3F));
    else if (c < 0x10000)
      b[n++] = static_cast<char>(0xE0 | (c >> 12)), b[n++] = static_cast<char>(0x80 | ((c >> 6) & 0x3F)),
      b[n++] = static_cast<char>(0x80 | (c & 0x3F));
    else
      b[n++] = static_cast<char>(0xF0 | (c >> 18)), b[n++] = static_cast<char>(0x80 | ((c >> 12) & 0x3F)),
      b[n++] = static_cast<char>(0x80 | ((c >> 6) & 0x3F)), b[n++] = static_cast<char>(0x80 | (c & 0x3F));
    out.append(b, n);
  }
  bool hex4(uint32_t& v) {
    if (end - p < 4) return fail("Bad unicode escape");
    v = 0;
    for (int i = 0; i < 4; ++i, ++p) {
      const char c = *p;
      v <<= 4;
      if (c >= '0' && c <= '9')
        v |= static_cast<uint32_t>(c - '0');
      else if (c >= 'a' && c <= 'f')
        v |= static_cast<uint32_t>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F')
        v |= static_cast<uint32_t>(c - 'A' + 10);
      else
        return fail("Bad unicode escape");
    }
    return true;
  }
  bool string(Str& out) {
    ++p;  // opening quote
    while (p < end) {
      const auto c = static_cast<uint8_t>(*p);
      if (c == '"') {
        ++p;
        return true;
      }
      if (c < 0x20) return fail("Bad control character in string");
      if (c != '\\') {
        out.push(static_cast<char>(c));
        ++p;
        continue;
      }
      if (++p >= end) break;
      const char e = *p++;
      switch (e) {
        case '"': out.push('"'); break;
        case '\\': out.push('\\'); break;
        case '/': out.push('/'); break;
        case 'b': out.push('\b'); break;
        case 'f': out.push('\f'); break;
        case 'n': out.push('\n'); break;
        case 'r': out.push('\r'); break;
        case 't': out.push('\t'); break;
        case 'u': {
          uint32_t u = 0;
          if (!hex4(u)) return false;
          // A surrogate pair becomes one code point; a lone surrogate stays (WTF-8).
          if (u >= 0xD800 && u <= 0xDBFF && end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
            const char* save = p;
            p += 2;
            uint32_t low = 0;
            if (hex4(low) && low >= 0xDC00 && low <= 0xDFFF)
              u = 0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00);
            else
              p = save, error = Str();
          }
          utf8(out, u);
          break;
        }
        default:
          return fail("Bad escaped character");
      }
    }
    return fail("Unterminated string");
  }
  bool number(double& out) {
    const char* start = p;
    if (p < end && *p == '-') ++p;
    if (p < end && *p == '0')
      ++p;
    else if (p < end && *p >= '1' && *p <= '9')
      while (p < end && *p >= '0' && *p <= '9') ++p;
    else
      return fail("Bad number");
    if (p < end && *p == '.') {
      ++p;
      if (p >= end || *p < '0' || *p > '9') return fail("Bad number");
      while (p < end && *p >= '0' && *p <= '9') ++p;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
      ++p;
      if (p < end && (*p == '+' || *p == '-')) ++p;
      if (p >= end || *p < '0' || *p > '9') return fail("Bad number");
      while (p < end && *p >= '0' && *p <= '9') ++p;
    }
    // Up to 19 significant digits: exact and fast (numbers.hpp); longer ones go to strtod.
    {
      const char* c = start;
      const bool negative = *c == '-';
      if (negative) ++c;
      uint64_t w = 0;
      int32_t q = 0, significant = 0;
      bool fits = true;
      for (; c < p && *c >= '0' && *c <= '9'; ++c)
        if (w || *c != '0') {
          if (significant++ == 19) fits = false;
          w = w * 10 + static_cast<uint64_t>(*c - '0');
        }
      if (c < p && *c == '.')
        for (++c; c < p && *c >= '0' && *c <= '9'; ++c) {
          if (w || *c != '0') {
            if (significant++ == 19) fits = false;
            w = w * 10 + static_cast<uint64_t>(*c - '0');
          }
          --q;
        }
      if (c < p && (*c == 'e' || *c == 'E')) {
        ++c;
        const bool down = *c == '-';
        if (*c == '+' || *c == '-') ++c;
        int32_t e = 0;
        for (; c < p && *c >= '0' && *c <= '9'; ++c)
          if (e < 100000) e = e * 10 + (*c - '0');
        q += down ? -e : e;
      }
      if (fits && numbers::parse(w, q, negative, out)) return true;
    }
    const Str text(start, static_cast<size_t>(p - start));
    out = strtod(text.c_str(), nullptr);
    return true;
  }
  bool literal(const char* word) {
    const size_t n = strlen(word);
    if (static_cast<size_t>(end - p) < n || memcmp(p, word, n) != 0) return fail("Unexpected token");
    p += n;
    return true;
  }
  bool value(Value& out, int32_t depth) {
    if (depth > kMaxDepth) return fail("JSON nesting too deep");
    space();
    if (p >= end) return fail("Unexpected end of JSON input");
    const char c = *p;
    if (c == '{') {
      ++p;
      out = Value::new_object();
      space();
      if (p < end && *p == '}') return ++p, true;
      for (;;) {
        space();
        if (p >= end || *p != '"') return fail("Expected property name");
        Str key;
        if (!string(key)) return false;
        space();
        if (p >= end || *p != ':') return fail("Expected ':' after property name");
        ++p;
        Value v;
        if (!value(v, depth + 1)) return false;
        out.set(key, xmp::move(v));
        space();
        if (p < end && *p == ',') {
          ++p;
          continue;
        }
        if (p < end && *p == '}') return ++p, true;
        return fail("Expected ',' or '}' after property value");
      }
    }
    if (c == '[') {
      ++p;
      out = Value::new_array();
      space();
      if (p < end && *p == ']') return ++p, true;
      for (;;) {
        Value v;
        if (!value(v, depth + 1)) return false;
        out.push(xmp::move(v));
        space();
        if (p < end && *p == ',') {
          ++p;
          continue;
        }
        if (p < end && *p == ']') return ++p, true;
        return fail("Expected ',' or ']' after array element");
      }
    }
    if (c == '"') {
      Str s;
      if (!string(s)) return false;
      out = Value::of(xmp::move(s));
      return true;
    }
    if (c == 't') return literal("true") && (out = Value::of(true), true);
    if (c == 'f') return literal("false") && (out = Value::of(false), true);
    if (c == 'n') return literal("null") && (out = Value(), true);
    double n = 0;
    if (!number(n)) return false;
    out = Value::of(n);
    return true;
  }
};
}  // namespace detail

inline ParseResult parse(const char* text, size_t length) {
  detail::Reader r{text, text + length, Str()};
  ParseResult out;
  if (r.value(out.value, 0)) {
    r.space();
    if (r.p == r.end)
      out.ok = true;
    else
      r.fail("Unexpected non-whitespace character after JSON");
  }
  if (!out.ok) out.error = r.error, out.value = Value();
  return out;
}
inline ParseResult parse(const Str& text) { return parse(text.data(), text.size()); }

// ---- writing ----
// JavaScript's layout of `count` digits d1.d2... x 10^exponent into `out`
// (at most 26 characters); returns the length.
inline int layout_chars(bool negative, const char* digits, int count, int exponent, char* out) {
  int k = 0;
  if (negative) out[k++] = '-';
  const int n = exponent + 1;  // the value is 0.digits x 10^n
  if (count <= n && n <= 21) {
    for (int i = 0; i < count; ++i) out[k++] = digits[i];
    for (int i = count; i < n; ++i) out[k++] = '0';
  } else if (0 < n && n <= 21) {
    for (int i = 0; i < n; ++i) out[k++] = digits[i];
    out[k++] = '.';
    for (int i = n; i < count; ++i) out[k++] = digits[i];
  } else if (-6 < n && n <= 0) {
    out[k++] = '0', out[k++] = '.';
    for (int i = 0; i < -n; ++i) out[k++] = '0';
    for (int i = 0; i < count; ++i) out[k++] = digits[i];
  } else {
    out[k++] = digits[0];
    if (count > 1) {
      out[k++] = '.';
      for (int i = 1; i < count; ++i) out[k++] = digits[i];
    }
    out[k++] = 'e', out[k++] = n - 1 >= 0 ? '+' : '-';
    int e = n - 1 >= 0 ? n - 1 : 1 - n;
    char rev[8];
    int r = 0;
    do rev[r++] = static_cast<char>('0' + e % 10), e /= 10;
    while (e);
    while (r) out[k++] = rev[--r];
  }
  return k;
}

// JavaScript's layout of `count` significant digits d1.d2... x 10^exponent.
inline Str detail_format(bool negative, char* digits, int count, int exponent) {
  while (count > 1 && digits[count - 1] == '0') --count;
  Str out;
  if (negative) out.push('-');
  const int n = exponent + 1;  // the value is 0.digits x 10^n
  if (count <= n && n <= 21) {
    out.append(digits, static_cast<size_t>(count));
    for (int i = count; i < n; ++i) out.push('0');
  } else if (0 < n && n <= 21) {
    out.append(digits, static_cast<size_t>(n)).push('.').append(digits + n, static_cast<size_t>(count - n));
  } else if (-6 < n && n <= 0) {
    out.append("0.");
    for (int i = 0; i < -n; ++i) out.push('0');
    out.append(digits, static_cast<size_t>(count));
  } else {
    out.push(digits[0]);
    if (count > 1) out.push('.').append(digits + 1, static_cast<size_t>(count - 1));
    out.push('e').push(n - 1 >= 0 ? '+' : '-').append(int_text(n - 1 >= 0 ? n - 1 : 1 - n));
  }
  return out;
}
// JavaScript's Number.prototype.toString for a finite double.
inline Str number_text(double x) {
  if (x == 0) return Str("0");
  if (!isfinite(x)) return Str("null");
  // The shortest digits that read back exactly. At each length the correctly
  // rounded digits come first; when the exact value lies on a tie (printf
  // rounds it to even), a neighbour in the last digit may be the one that
  // reads back, as JavaScript finds it (2^-24 is 5.960464477539063e-8).
  char buf[48];
  char digits[20];
  int count = 0, exponent = 0;
  const double magnitude = fabs(x);
  // Grisu3 (numbers.hpp), as V8: right for 99.5% of numbers, and it says when it can't be sure.
  int point = 0;
  if (numbers::shortest(magnitude, digits, count, point)) {
    exponent = point - 1;
    return detail_format(x < 0, digits, count, exponent);
  }
  auto reads_back = [&](const char* d, int n, int e) {
    char text[48];
    int k = 0;
    text[k++] = d[0];
    if (n > 1) {
      text[k++] = '.';
      for (int i = 1; i < n; ++i) text[k++] = d[i];
    }
    snprintf(text + k, sizeof text - static_cast<size_t>(k), "e%d", e);
    return strtod(text, nullptr) == magnitude;
  };
  for (int precision = 1; precision <= 17; ++precision) {
    snprintf(buf, sizeof buf, "%.*e", precision - 1, magnitude);
    count = 0;
    const char* q = buf;
    for (; *q && *q != 'e'; ++q)
      if (*q >= '0' && *q <= '9') digits[count++] = *q;
    exponent = atoi(q + 1);
    if (precision == 17 || reads_back(digits, count, exponent)) break;
    // The neighbours one unit away in the last digit.
    bool found = false;
    for (int step = 1; step >= -1 && !found; step -= 2) {
      char d[20];
      memcpy(d, digits, static_cast<size_t>(count));
      int e = exponent, i = count - 1;
      if (step > 0) {
        while (i >= 0 && d[i] == '9') d[i--] = '0';
        if (i < 0) {
          memmove(d + 1, d, static_cast<size_t>(count - 1));
          d[0] = '1', ++e;
        } else
          ++d[i];
      } else {
        while (i >= 0 && d[i] == '0') d[i--] = '9';
        if (i < 0 || (i == 0 && d[0] == '1' && count > 1)) continue;  // would lose a digit: not a neighbour here
        --d[i];
      }
      if (reads_back(d, count, e)) memcpy(digits, d, static_cast<size_t>(count)), exponent = e, found = true;
    }
    if (found) break;
  }
  return detail_format(x < 0, digits, count, exponent);
}

namespace detail {
inline void quote(Str& out, const Str& s) {
  static const char* hex = "0123456789abcdef";
  out.push('"');
  for (size_t i = 0; i < s.size(); ++i) {
    const auto c = static_cast<uint8_t>(s[i]);
    if (c == '"')
      out.append("\\\"");
    else if (c == '\\')
      out.append("\\\\");
    else if (c == '\b')
      out.append("\\b");
    else if (c == '\f')
      out.append("\\f");
    else if (c == '\n')
      out.append("\\n");
    else if (c == '\r')
      out.append("\\r");
    else if (c == '\t')
      out.append("\\t");
    else if (c < 0x20) {
      const char e[7] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 15], 0};
      out.append(e);
    } else if (c == 0xED && i + 2 < s.size() && (static_cast<uint8_t>(s[i + 1]) & 0xE0) == 0xA0) {
      // A lone surrogate (WTF-8): JSON.stringify writes it as an escape.
      const uint32_t u = 0xD000 | ((static_cast<uint8_t>(s[i + 1]) & 0x3F) << 6) | (static_cast<uint8_t>(s[i + 2]) & 0x3F);
      const char e[7] = {'\\', 'u', 'd', hex[(u >> 8) & 15], hex[(u >> 4) & 15], hex[u & 15], 0};
      out.append(e);
      i += 2;
    } else
      out.push(static_cast<char>(c));
  }
  out.push('"');
}
inline void newline(Str& out, int32_t indent, int32_t depth) {
  out.push('\n');
  for (int32_t i = 0; i < indent * depth; ++i) out.push(' ');
}
inline void write(Str& out, const Value& v, int32_t indent, int32_t depth) {
  switch (v.kind()) {
    case Value::null: out.append("null"); break;
    case Value::boolean: out.append(v.as_bool() ? "true" : "false"); break;
    case Value::number: {
      // The common case straight into the output: no string per number (a sample can be 480,000 of them).
      const double x = v.as_number();
      char digits[18], text[32];
      int count = 0, point = 0;
      if (x != 0 && isfinite(x) && numbers::shortest(fabs(x), digits, count, point))
        out.append(text, static_cast<size_t>(layout_chars(x < 0, digits, count, point - 1, text)));
      else
        out.append(number_text(x));
      break;
    }
    case Value::string: quote(out, v.as_string()); break;
    case Value::array: {
      if (v.items().empty()) {
        out.append("[]");
        break;
      }
      out.push('[');
      for (int32_t i = 0; i < v.items().size(); ++i) {
        if (i) out.push(',');
        if (indent) newline(out, indent, depth + 1);
        write(out, v.items()[i], indent, depth + 1);
      }
      if (indent) newline(out, indent, depth);
      out.push(']');
      break;
    }
    case Value::object: {
      if (v.members().empty()) {
        out.append("{}");
        break;
      }
      out.push('{');
      for (int32_t i = 0; i < v.members().size(); ++i) {
        if (i) out.push(',');
        if (indent) newline(out, indent, depth + 1);
        quote(out, v.members()[i].key);
        out.push(':');
        if (indent) out.push(' ');
        write(out, v.members()[i].value, indent, depth + 1);
      }
      if (indent) newline(out, indent, depth);
      out.push('}');
      break;
    }
  }
}
}  // namespace detail

// JSON.stringify(value) or, with `indent`, JSON.stringify(value, null, indent).
inline Str stringify(const Value& v, int32_t indent = 0) {
  Str out;
  detail::write(out, v, indent, 0);
  return out;
}

}  // namespace xmp::json
