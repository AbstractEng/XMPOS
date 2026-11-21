#pragma once
// XMP's small containers for the C++ core: a growable array (Vec) and a byte
// string (Str), on the C library's malloc. They exist because the WebAssembly
// build has the C library only, with no C++ standard library (docs/cpp-port.md);
// the same code builds natively. No exceptions: allocation failure aborts.
//
// Not for the audio thread: these allocate. Real-time code uses fixed tables.
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if __has_include(<new>)
#include <new>
#else
inline void* operator new(size_t, void* at) noexcept { return at; }
#endif

namespace xmp {

template <class T> struct remove_ref { using type = T; };
template <class T> struct remove_ref<T&> { using type = T; };
template <class T> struct remove_ref<T&&> { using type = T; };
template <class T> constexpr typename remove_ref<T>::type&& move(T&& v) noexcept {
  return static_cast<typename remove_ref<T>::type&&>(v);
}

inline void* checked_alloc(size_t bytes) {
  void* p = malloc(bytes ? bytes : 1);
  if (!p) abort();
  return p;
}

// A growable array. Elements are moved when it grows.
template <class T>
class Vec {
 public:
  Vec() = default;
  Vec(const Vec& o) { copy_from(o); }
  Vec(Vec&& o) noexcept : data_(o.data_), size_(o.size_), cap_(o.cap_) { o.data_ = nullptr, o.size_ = o.cap_ = 0; }
  Vec& operator=(const Vec& o) {
    if (this != &o) {
      clear();
      copy_from(o);
    }
    return *this;
  }
  Vec& operator=(Vec&& o) noexcept {
    if (this != &o) {
      release();
      data_ = o.data_, size_ = o.size_, cap_ = o.cap_;
      o.data_ = nullptr, o.size_ = o.cap_ = 0;
    }
    return *this;
  }
  ~Vec() { release(); }

  int32_t size() const { return size_; }
  int32_t capacity() const { return cap_; }
  bool empty() const { return size_ == 0; }
  T& operator[](int32_t i) { return data_[i]; }
  const T& operator[](int32_t i) const { return data_[i]; }
  T* begin() { return data_; }
  T* end() { return data_ + size_; }
  const T* begin() const { return data_; }
  const T* end() const { return data_ + size_; }
  T& back() { return data_[size_ - 1]; }
  const T& back() const { return data_[size_ - 1]; }

  void reserve(int32_t n) {
    if (n <= cap_) return;
    T* next = static_cast<T*>(checked_alloc(sizeof(T) * static_cast<size_t>(n)));
    for (int32_t i = 0; i < size_; ++i) {
      new (next + i) T(xmp::move(data_[i]));
      data_[i].~T();
    }
    free(data_);
    data_ = next, cap_ = n;
  }
  T& push(const T& v) {
    grow();
    return *new (data_ + size_++) T(v);
  }
  T& push(T&& v) {
    grow();
    return *new (data_ + size_++) T(xmp::move(v));
  }
  void pop() { data_[--size_].~T(); }
  void erase(int32_t i) {
    for (int32_t k = i; k + 1 < size_; ++k) data_[k] = xmp::move(data_[k + 1]);
    pop();
  }
  void insert(int32_t i, T v) {
    push(xmp::move(v));
    for (int32_t k = size_ - 1; k > i; --k) {
      T t = xmp::move(data_[k]);
      data_[k] = xmp::move(data_[k - 1]);
      data_[k - 1] = xmp::move(t);
    }
  }
  void clear() {
    for (int32_t i = 0; i < size_; ++i) data_[i].~T();
    size_ = 0;
  }

 private:
  void grow() {
    if (size_ == cap_) reserve(cap_ ? cap_ * 2 : 4);
  }
  void copy_from(const Vec& o) {
    reserve(o.size_);
    for (int32_t i = 0; i < o.size_; ++i) new (data_ + i) T(o.data_[i]);
    size_ = o.size_;
  }
  void release() {
    clear();
    free(data_);
    data_ = nullptr, cap_ = 0;
  }
  T* data_ = nullptr;
  int32_t size_ = 0, cap_ = 0;
};

// A byte string, always NUL-terminated. Text is UTF-8; a lone UTF-16
// surrogate from JSON (which JavaScript strings may hold) is kept as its
// 3-byte encoding (WTF-8), so text round-trips exactly.
class Str {
 public:
  Str() = default;
  Str(const char* s) { assign(s, s ? strlen(s) : 0); }
  Str(const char* s, size_t n) { assign(s, n); }
  Str(const Str& o) { assign(o.data(), o.size()); }
  Str(Str&& o) noexcept : bytes_(xmp::move(o.bytes_)) {}
  Str& operator=(const Str& o) {
    if (this != &o) assign(o.data(), o.size());
    return *this;
  }
  Str& operator=(Str&& o) noexcept {
    bytes_ = xmp::move(o.bytes_);
    return *this;
  }

  size_t size() const { return bytes_.size() ? static_cast<size_t>(bytes_.size() - 1) : 0; }
  bool empty() const { return size() == 0; }
  const char* data() const { return bytes_.size() ? bytes_.begin() : ""; }
  const char* c_str() const { return data(); }
  char operator[](size_t i) const { return data()[i]; }

  Str& append(const char* s, size_t n) {
    if (bytes_.size()) bytes_.pop();
    const int32_t needed = bytes_.size() + static_cast<int32_t>(n) + 1;
    if (needed > bytes_.capacity()) bytes_.reserve(needed > bytes_.capacity() * 2 ? needed : bytes_.capacity() * 2);
    for (size_t i = 0; i < n; ++i) bytes_.push(s[i]);
    bytes_.push('\0');
    return *this;
  }
  Str& append(const char* s) { return append(s, strlen(s)); }
  Str& append(const Str& s) { return append(s.data(), s.size()); }
  Str& push(char c) { return append(&c, 1); }
  Str& operator+=(const Str& s) { return append(s); }
  Str& operator+=(const char* s) { return append(s); }
  Str& operator+=(char c) { return push(c); }

  bool operator==(const Str& o) const { return size() == o.size() && memcmp(data(), o.data(), size()) == 0; }
  bool operator!=(const Str& o) const { return !(*this == o); }
  bool operator==(const char* s) const { return strlen(s) == size() && memcmp(data(), s, size()) == 0; }
  bool operator!=(const char* s) const { return !(*this == s); }
  bool starts_with(const Str& p) const { return p.size() <= size() && memcmp(data(), p.data(), p.size()) == 0; }
  bool starts_with(const char* p) const { return starts_with(Str(p)); }
  Str slice(size_t from, size_t to) const {
    if (to > size()) to = size();
    if (from > to) from = to;
    return Str(data() + from, to - from);
  }
  // Code points (a lone surrogate counts as one), as zod 4 measures strings.
  size_t code_points() const {
    size_t n = 0;
    for (size_t i = 0; i < size(); ++i) n += (static_cast<uint8_t>(data()[i]) & 0xC0) != 0x80;
    return n;
  }
  // JavaScript's s.slice(0, n): the first n UTF-16 units. A surrogate pair cut
  // in half leaves its high surrogate alone (as WTF-8), as JavaScript does.
  Str utf16_prefix(size_t n) const {
    Str out;
    size_t units = 0, i = 0;
    while (i < size() && units < n) {
      const auto c = static_cast<uint8_t>(data()[i]);
      const size_t width = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
      if (c >= 0xF0 && units + 1 == n) {
        // Keep only the high surrogate of this code point.
        const uint32_t cp = ((c & 0x07u) << 18) | ((static_cast<uint8_t>(data()[i + 1]) & 0x3Fu) << 12) |
                            ((static_cast<uint8_t>(data()[i + 2]) & 0x3Fu) << 6) | (static_cast<uint8_t>(data()[i + 3]) & 0x3Fu);
        const uint32_t high = 0xD800 + ((cp - 0x10000) >> 10);
        const char b[3] = {static_cast<char>(0xE0 | (high >> 12)), static_cast<char>(0x80 | ((high >> 6) & 0x3F)),
                           static_cast<char>(0x80 | (high & 0x3F))};
        out.append(b, 3);
        return out;
      }
      out.append(data() + i, width);
      units += c >= 0xF0 ? 2 : 1;
      i += width;
    }
    return out;
  }
  // Length in UTF-16 code units, as JavaScript counts a string.
  size_t utf16_length() const {
    size_t n = 0;
    for (size_t i = 0; i < size(); ++i) {
      const auto c = static_cast<uint8_t>(data()[i]);
      if ((c & 0xC0) != 0x80) n += c >= 0xF0 ? 2 : 1;
    }
    return n;
  }

 private:
  void assign(const char* s, size_t n) {
    bytes_.clear();
    bytes_.reserve(static_cast<int32_t>(n) + 1);
    for (size_t i = 0; i < n; ++i) bytes_.push(s[i]);
    bytes_.push('\0');
  }
  Vec<char> bytes_;
};

inline Str operator+(Str a, const Str& b) { return a.append(b); }
inline Str operator+(Str a, const char* b) { return a.append(b); }

// Decimal text of an integer.
inline Str int_text(int64_t v) {
  char buf[24];
  int n = 0;
  const bool negative = v < 0;
  uint64_t u = negative ? static_cast<uint64_t>(-(v + 1)) + 1 : static_cast<uint64_t>(v);
  do {
    buf[n++] = static_cast<char>('0' + u % 10);
    u /= 10;
  } while (u);
  Str out;
  if (negative) out.push('-');
  while (n) out.push(buf[--n]);
  return out;
}

}  // namespace xmp
