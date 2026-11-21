#pragma once
// A small structural checker for XMP's JSON documents, with the semantics of
// the zod schemas in packages/core (zod 4) that it replaces:
//   - numbers are finite; .int() is a safe integer; min and max inclusive;
//   - string lengths count Unicode code points, as zod 4 does (a surrogate
//     pair once, a lone surrogate as one), not JavaScript's UTF-16 .length;
//   - strict objects refuse unknown keys; optional keys may be absent;
//   - the output object has the schema's key order (extended schemas keep a
//     field's original position and append new ones); absent optional keys are
//     left out; records keep the input's key order and drop "__proto__", as
//     zod does when it assigns that key;
//   - tuples have exactly their items.
// It reports whether the value conforms (and the first problem, in its own
// words; zod's messages are not reproduced) and builds the canonical output.
#include "xmp/json.hpp"

namespace xmp::schema {

using json::Value;

struct Node;
struct Field {
  Str name;
  const Node* node = nullptr;
  bool optional = false;
};

enum class Text : uint8_t { any, id, id32, machine_id, parameter_id, short_key };

struct Node {
  enum Kind : uint8_t { number, string, boolean, literal, choice, array, tuple, object, record, unknown, variant };
  Kind kind = unknown;
  // number
  bool integer = false, has_min = false, has_max = false;
  double min = 0, max = 0, multiple = 0;
  // string and array sizes (code points for strings)
  int64_t size_min = -1, size_max = -1;
  Text text = Text::any;
  // literal and choice: the allowed values (numbers or strings)
  Vec<Value> options;
  // array, record values, tuple items
  const Node* element = nullptr;
  const Node* key = nullptr;
  Vec<const Node*> items;
  // object
  Vec<Field> fields;
  bool strict = true;
  // variant (zod's discriminatedUnion): `items[i]` for discriminator value `options[i]`
  Str discriminator;
};

// ---- text patterns of the schemas ----
inline bool id_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}
// /^[a-zA-Z0-9_-]{1,max}$/
inline bool is_id(const char* s, size_t n, size_t max = 64) {
  if (n < 1 || n > max) return false;
  for (size_t i = 0; i < n; ++i)
    if (!id_char(s[i])) return false;
  return true;
}
inline bool is_id(const Str& s, size_t max = 64) { return is_id(s.data(), s.size(), max); }
inline bool lower_or_digit(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'); }
// /^[a-z][a-z0-9.-]{1,63}$/
inline bool is_machine_id(const char* s, size_t n) {
  if (n < 2 || n > 64 || !(s[0] >= 'a' && s[0] <= 'z')) return false;
  for (size_t i = 1; i < n; ++i)
    if (!lower_or_digit(s[i]) && s[i] != '.' && s[i] != '-') return false;
  return true;
}
inline bool is_machine_id(const Str& s) { return is_machine_id(s.data(), s.size()); }

namespace detail {
// A small backtracking matcher for the parameter ID pattern of sequence-schema.ts:
// ^(master\.gain|return\.[01]\.insert\.ID\.[a-z]{1,16}|track\.ID\.(gain|pan|send\.[01]|
//   insert\.ID\.[a-z]{1,16}|effect\.gain|machine\.[a-z][a-z0-9.-]{1,63}\.v[1-9][0-9]{0,3}\.[a-z][a-z0-9-]{0,31}))$
// ID is [a-zA-Z0-9_-]{1,64}. Run lengths are tried longest first, then shorter,
// as a regular expression engine would, so dots inside machine IDs match.
struct P {
  const char* s;
  size_t n;
  bool lit(size_t& i, const char* t) const {
    const size_t k = strlen(t);
    if (i + k > n || memcmp(s + i, t, k) != 0) return false;
    i += k;
    return true;
  }
};
inline bool lowers(const char* s, size_t from, size_t to, size_t lo, size_t hi) {
  const size_t k = to - from;
  if (k < lo || k > hi) return false;
  for (size_t i = from; i < to; ++i)
    if (!(s[i] >= 'a' && s[i] <= 'z')) return false;
  return true;
}
// [a-z][a-z0-9-]{0,31} to the end
inline bool machine_parameter(const char* s, size_t from, size_t n) {
  if (from >= n || n - from > 32 || !(s[from] >= 'a' && s[from] <= 'z')) return false;
  for (size_t i = from + 1; i < n; ++i)
    if (!lower_or_digit(s[i]) && s[i] != '-') return false;
  return true;
}
// machine\.[a-z][a-z0-9.-]{1,63}\.v[1-9][0-9]{0,3}\.PARAM, from just after "machine."
inline bool machine_tail(const char* s, size_t from, size_t n) {
  // The machine ID may contain dots: try every split where ".v<digits>." follows.
  if (from >= n || !(s[from] >= 'a' && s[from] <= 'z')) return false;
  for (size_t end = from + 2; end <= from + 64 && end < n; ++end) {
    // [a-z0-9.-] for s[from+1 .. end)
    bool ok = true;
    for (size_t i = from + 1; i < end && ok; ++i) ok = lower_or_digit(s[i]) || s[i] == '.' || s[i] == '-';
    if (!ok) break;
    if (s[end] != '.' || end + 2 >= n || s[end + 1] != 'v' || !(s[end + 2] >= '1' && s[end + 2] <= '9')) continue;
    size_t i = end + 3;
    for (size_t digits = 0; digits < 3 && i < n && s[i] >= '0' && s[i] <= '9'; ++digits, ++i) {
    }
    // Every shorter digit run is also a candidate.
    for (size_t stop = i; stop >= end + 3; --stop) {
      if (stop < n && s[stop] == '.' && machine_parameter(s, stop + 1, n)) return true;
      if (stop == end + 3) break;
    }
  }
  return false;
}
// ID\.[a-z]{1,16} to the end (insert.ID.key)
inline bool insert_tail(const char* s, size_t from, size_t n) {
  for (size_t dot = n; dot-- > from;) {
    if (s[dot] != '.') continue;
    return is_id(s + from, dot - from) && lowers(s, dot + 1, n, 1, 16);
  }
  return false;
}
}  // namespace detail

inline bool is_parameter_id(const char* s, size_t n) {
  detail::P p{s, n};
  size_t i = 0;
  if (n == 11 && memcmp(s, "master.gain", 11) == 0) return true;
  if (p.lit(i, "return.")) {
    if (i >= n || (s[i] != '0' && s[i] != '1')) return false;
    ++i;
    return p.lit(i, ".insert.") && detail::insert_tail(s, i, n);
  }
  i = 0;
  if (!p.lit(i, "track.")) return false;
  // track.ID.<rest>: the ID has no dots, so it ends at the next dot.
  size_t dot = i;
  while (dot < n && s[dot] != '.') ++dot;
  if (dot >= n || !is_id(s + i, dot - i)) return false;
  const char* rest = s + dot + 1;
  const size_t r = n - dot - 1;
  auto is = [&](const char* t) { return strlen(t) == r && memcmp(rest, t, r) == 0; };
  if (is("gain") || is("pan") || is("send.0") || is("send.1") || is("effect.gain")) return true;
  if (r > 7 && memcmp(rest, "insert.", 7) == 0) return detail::insert_tail(rest, 7, r);
  if (r > 8 && memcmp(rest, "machine.", 8) == 0) return detail::machine_tail(rest, 8, r);
  return false;
}
inline bool is_parameter_id(const Str& s) { return is_parameter_id(s.data(), s.size()); }

// ---- checking ----
class Checker {
 public:
  Str problem;  // the first problem found, empty when the value conforms
  int32_t proto_objects = 0;  // "__proto__" keys holding an object, in records of any value

  bool fail(const Str& where, const char* what) {
    if (problem.empty()) problem = where + ": " + what;
    return false;
  }

  // Why `v` is not a number `node` allows (nullptr: it is).
  static const char* number_problem(const Node& node, const Value& v) {
    if (!v.is_number()) return "expected a number";
    const double x = v.as_number();
    if (!isfinite(x)) return "expected a finite number";
    if (node.integer && (x != floor(x) || fabs(x) > 9007199254740991.0)) return "expected an integer";
    if (node.has_min && x < node.min) return "number too small";
    if (node.has_max && x > node.max) return "number too big";
    if (node.multiple > 0 && fmod(x, node.multiple) != 0) return "not a multiple";
    return nullptr;
  }

  // Checks `v` against `node`; on success `out` is the canonical value.
  bool check(const Node& node, const Value& v, Value& out, const Str& where) {
    switch (node.kind) {
      case Node::unknown:
        out = v;
        return true;
      case Node::boolean:
        if (!v.is_bool()) return fail(where, "expected a boolean");
        out = v;
        return true;
      case Node::number: {
        if (const char* problem = number_problem(node, v)) return fail(where, problem);
        out = v;
        return true;
      }
      case Node::string: {
        if (!v.is_string()) return fail(where, "expected a string");
        if (!text_ok(node, v.as_string())) return fail(where, "text out of bounds or malformed");
        out = v;
        return true;
      }
      case Node::literal:
      case Node::choice:
        for (const auto& o : node.options)
          if (same(o, v)) {
            out = v;
            return true;
          }
        return fail(where, "value not allowed");
      case Node::array:
      case Node::tuple: {
        if (!v.is_array()) return fail(where, "expected an array");
        const int32_t n = v.items().size();
        if (node.kind == Node::tuple) {
          if (n != node.items.size()) return fail(where, "wrong number of items");
        } else if ((node.size_min >= 0 && n < node.size_min) || (node.size_max >= 0 && n > node.size_max))
          return fail(where, "wrong number of items");
        if (node.kind == Node::array && node.element->kind == Node::number) {
          // Arrays of numbers (a sample's audio: up to 480,000): a tight loop, the
          // location written only for an item that fails, and the array kept as it
          // is (shared, not copied) when every item passes.
          const Vec<Value>& items = v.items();
          for (int32_t i = 0; i < n; ++i)
            if (const char* problem = number_problem(*node.element, items[i]))
              return fail(where + "[" + int_text(i) + "]", problem);
          out = v;
          return true;
        }
        out = Value::new_array();
        out.items().reserve(n);
        for (int32_t i = 0; i < n; ++i) {
          Value item;
          const Node& e = node.kind == Node::tuple ? *node.items[i] : *node.element;
          if (!check(e, v.items()[i], item, where + "[" + int_text(i) + "]")) return false;
          out.push(xmp::move(item));
        }
        return true;
      }
      case Node::record: {
        if (!v.is_object()) return fail(where, "expected an object");
        out = Value::new_object();
        for (const auto& m : v.members()) {
          Value k = Value::of(m.key), ignored, value;
          if (node.key && !check(*node.key, k, ignored, where + "." + m.key)) return false;
          if (!check(*node.element, m.value, value, where + "." + m.key)) return false;
          if (m.key != "__proto__")
            out.set(m.key, xmp::move(value));
          else if (node.element->kind == Node::unknown && (m.value.is_object() || m.value.is_array()))
            ++proto_objects;
        }
        return true;
      }
      case Node::variant: {
        if (!v.is_object()) return fail(where, "expected an object");
        const Value* d = v.get(node.discriminator.c_str());
        for (int32_t i = 0; d && i < node.options.size(); ++i)
          if (same(node.options[i], *d)) return check(*node.items[i], v, out, where);
        return fail(where, "unknown kind");
      }
      case Node::object: {
        if (!v.is_object()) return fail(where, "expected an object");
        if (node.strict)
          for (const auto& m : v.members()) {
            bool known = false;
            for (const auto& f : node.fields) known = known || f.name == m.key;
            if (!known) return fail(where, "unrecognized key");
          }
        out = Value::new_object();
        for (const auto& f : node.fields) {
          const Value* child = v.get(f.name.c_str());
          if (!child) {
            if (f.optional) continue;
            return fail(where + "." + f.name, "missing");
          }
          Value value;
          if (!check(*f.node, *child, value, where + "." + f.name)) return false;
          out.members().push(json::Member{f.name, xmp::move(value)});
        }
        return true;
      }
    }
    return false;
  }

 private:
  static bool same(const Value& a, const Value& b) {
    if (a.kind() != b.kind()) return false;
    if (a.is_number()) return a.as_number() == b.as_number();
    if (a.is_string()) return a.as_string() == b.as_string();
    return false;
  }
  static bool text_ok(const Node& node, const Str& s) {
    switch (node.text) {
      case Text::id: return is_id(s);
      case Text::id32: return is_id(s, 32);
      case Text::machine_id: return is_machine_id(s);
      case Text::parameter_id: return is_parameter_id(s);
      default: break;
    }
    const auto n = static_cast<int64_t>(s.code_points());
    return (node.size_min < 0 || n >= node.size_min) && (node.size_max < 0 || n <= node.size_max);
  }
};

// ---- building schemas (a fixed pool, built once) ----
class Builder {
 public:
  ~Builder() {
    for (auto* n : nodes_) {
      n->~Node();
      free(n);
    }
  }
  Node& make(Node::Kind kind) {
    Node* n = new (checked_alloc(sizeof(Node))) Node{};
    n->kind = kind;
    nodes_.push(n);
    return *n;
  }
  const Node* number(double lo, double hi, bool integer = false) {
    Node& n = make(Node::number);
    n.has_min = n.has_max = true, n.min = lo, n.max = hi, n.integer = integer;
    return &n;
  }
  const Node* integer(double lo, double hi) { return number(lo, hi, true); }
  const Node* unit() { return number(0, 1); }
  const Node* boolean() { return &make(Node::boolean); }
  const Node* text(int64_t lo, int64_t hi) {
    Node& n = make(Node::string);
    n.size_min = lo, n.size_max = hi;
    return &n;
  }
  const Node* pattern(Text t) {
    Node& n = make(Node::string);
    n.text = t;
    return &n;
  }
  const Node* literal(double v) {
    Node& n = make(Node::literal);
    n.options.push(Value::of(v));
    return &n;
  }
  const Node* literal(const char* v) {
    Node& n = make(Node::literal);
    n.options.push(Value::of(v));
    return &n;
  }
  const Node* choice(const char* const* names, int32_t count) {
    Node& n = make(Node::choice);
    for (int32_t i = 0; i < count; ++i) n.options.push(Value::of(names[i]));
    return &n;
  }
  const Node* number_choice(const double* values, int32_t count) {
    Node& n = make(Node::choice);
    for (int32_t i = 0; i < count; ++i) n.options.push(Value::of(values[i]));
    return &n;
  }
  const Node* array(const Node* element, int64_t lo, int64_t hi) {
    Node& n = make(Node::array);
    n.element = element, n.size_min = lo, n.size_max = hi;
    return &n;
  }
  const Node* tuple2(const Node* a, const Node* b) {
    Node& n = make(Node::tuple);
    n.items.push(a), n.items.push(b);
    return &n;
  }
  const Node* record(const Node* key, const Node* value) {
    Node& n = make(Node::record);
    n.key = key, n.element = value;
    return &n;
  }
  const Node* unknown() { return &make(Node::unknown); }
  Node& variant(const char* discriminator) {
    Node& n = make(Node::variant);
    n.discriminator = discriminator;
    return n;
  }
  Node& object() { return make(Node::object); }
  // zod's extend: a copy whose existing fields keep their place.
  Node& extend(const Node& base) {
    Node& n = make(Node::object);
    n.fields = base.fields;
    n.strict = base.strict;
    return n;
  }

 private:
  Vec<Node*> nodes_;
};

// Adds or replaces a field (replacing keeps its position).
inline Node& field(Node& object, const char* name, const Node* node, bool optional = false) {
  for (auto& f : object.fields)
    if (f.name == name) {
      f.node = node, f.optional = optional;
      return object;
    }
  object.fields.push(Field{Str(name), node, optional});
  return object;
}
inline const Node* field_node(const Node& object, const char* name) {
  for (const auto& f : object.fields)
    if (f.name == name) return f.node;
  return nullptr;
}

}  // namespace xmp::schema
