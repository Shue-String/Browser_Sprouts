#pragma once
// A minimal JSON document model + recursive-descent parser -- just enough to read
// src/data/collectionElements.json natively (the engine has no JSON dependency otherwise). Strings
// keep raw UTF-8 bytes (e.g. "⊕") as-is; only escapes are decoded. Errors throw
// std::runtime_error naming the byte offset / JSON path.
#include <string>
#include <vector>

namespace stalks {
namespace json {

struct Member;

struct Value {
    enum class Kind { Null, Bool, Number, String, Array, Object } kind = Kind::Null;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::vector<Value> array;
    std::vector<Member> object;

    // The member named `key`, or nullptr (also nullptr when this isn't an object).
    const Value* find(const std::string& key) const;
};

struct Member {
    std::string key;
    Value value;
};

Value parse(const std::string& text);

// Typed accessors: a schema violation throws, naming `where` (the JSON path being read).
const Value& member(const Value& obj, const std::string& key, const std::string& where);
int asInt(const Value& v, const std::string& where);
const std::string& asString(const Value& v, const std::string& where);
const std::vector<Value>& asArray(const Value& v, const std::string& where);
std::vector<int> intArray(const Value& v, const std::string& where);

}  // namespace json
}  // namespace stalks
