#include "json.hpp"

#include <cmath>
#include <cstdlib>
#include <stdexcept>

namespace stalks {
namespace json {

const Value* Value::find(const std::string& key) const {
    for (const auto& m : object)
        if (m.key == key) return &m.value;
    return nullptr;
}

namespace {

class Parser {
public:
    explicit Parser(const std::string& text) : s_(text) {}

    Value parseDocument() {
        Value v = parseValue();
        skipWs();
        if (i_ != s_.size()) fail("trailing characters");
        return v;
    }

private:
    const std::string& s_;
    std::size_t i_ = 0;

    [[noreturn]] void fail(const std::string& what) const {
        throw std::runtime_error("JSON parse error at byte " + std::to_string(i_) + ": " + what);
    }

    void skipWs() {
        while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) i_++;
    }

    void expect(char c) {
        skipWs();
        if (i_ >= s_.size() || s_[i_] != c) fail(std::string("expected '") + c + "'");
        i_++;
    }

    bool consumeLiteral(const char* lit) {
        const std::string l(lit);
        if (s_.compare(i_, l.size(), l) != 0) return false;
        i_ += l.size();
        return true;
    }

    Value parseValue() {
        skipWs();
        if (i_ >= s_.size()) fail("unexpected end of input");
        Value v;
        const char c = s_[i_];
        if (c == '{') {
            v.kind = Value::Kind::Object;
            i_++;
            skipWs();
            if (i_ < s_.size() && s_[i_] == '}') { i_++; return v; }
            while (true) {
                skipWs();
                std::string key = parseString();
                expect(':');
                v.object.push_back({std::move(key), parseValue()});
                skipWs();
                if (i_ < s_.size() && s_[i_] == ',') { i_++; continue; }
                expect('}');
                return v;
            }
        }
        if (c == '[') {
            v.kind = Value::Kind::Array;
            i_++;
            skipWs();
            if (i_ < s_.size() && s_[i_] == ']') { i_++; return v; }
            while (true) {
                v.array.push_back(parseValue());
                skipWs();
                if (i_ < s_.size() && s_[i_] == ',') { i_++; continue; }
                expect(']');
                return v;
            }
        }
        if (c == '"') {
            v.kind = Value::Kind::String;
            v.string = parseString();
            return v;
        }
        if (consumeLiteral("true")) { v.kind = Value::Kind::Bool; v.boolean = true; return v; }
        if (consumeLiteral("false")) { v.kind = Value::Kind::Bool; return v; }
        if (consumeLiteral("null")) return v;
        if (c == '-' || (c >= '0' && c <= '9')) {
            const char* begin = s_.c_str() + i_;
            char* end = nullptr;
            v.kind = Value::Kind::Number;
            v.number = std::strtod(begin, &end);
            if (end == begin) fail("bad number");
            i_ += static_cast<std::size_t>(end - begin);
            return v;
        }
        fail(std::string("unexpected character '") + c + "'");
    }

    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += static_cast<char>(cp);
        } else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    unsigned parseHex4() {
        if (i_ + 4 > s_.size()) fail("truncated \\u escape");
        unsigned cp = 0;
        for (int k = 0; k < 4; k++) {
            const char h = s_[i_++];
            cp <<= 4;
            if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
            else fail("bad \\u escape");
        }
        return cp;
    }

    std::string parseString() {
        if (i_ >= s_.size() || s_[i_] != '"') fail("expected string");
        i_++;
        std::string out;
        while (true) {
            if (i_ >= s_.size()) fail("unterminated string");
            const char c = s_[i_++];
            if (c == '"') return out;
            if (c != '\\') { out += c; continue; }
            if (i_ >= s_.size()) fail("unterminated escape");
            const char e = s_[i_++];
            switch (e) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp = parseHex4();
                    if (cp >= 0xD800 && cp < 0xDC00 && consumeLiteral("\\u")) {
                        const unsigned lo = parseHex4();
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: fail(std::string("bad escape '\\") + e + "'");
            }
        }
    }
};

}  // namespace

Value parse(const std::string& text) { return Parser(text).parseDocument(); }

const Value& member(const Value& obj, const std::string& key, const std::string& where) {
    if (obj.kind != Value::Kind::Object) throw std::runtime_error(where + ": expected an object");
    const Value* v = obj.find(key);
    if (!v) throw std::runtime_error(where + ": missing \"" + key + "\"");
    return *v;
}

int asInt(const Value& v, const std::string& where) {
    if (v.kind != Value::Kind::Number || v.number != std::floor(v.number))
        throw std::runtime_error(where + ": expected an integer");
    return static_cast<int>(v.number);
}

const std::string& asString(const Value& v, const std::string& where) {
    if (v.kind != Value::Kind::String) throw std::runtime_error(where + ": expected a string");
    return v.string;
}

const std::vector<Value>& asArray(const Value& v, const std::string& where) {
    if (v.kind != Value::Kind::Array) throw std::runtime_error(where + ": expected an array");
    return v.array;
}

std::vector<int> intArray(const Value& v, const std::string& where) {
    std::vector<int> out;
    for (const auto& x : asArray(v, where)) out.push_back(asInt(x, where));
    return out;
}

}  // namespace json
}  // namespace stalks
