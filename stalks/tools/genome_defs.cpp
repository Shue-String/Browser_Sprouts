#include "genome_defs.hpp"

#include "collections.hpp"
#include "json.hpp"

#include <stdexcept>

namespace stalks_tools {
namespace genome_defs {

namespace {

using namespace stalks;

GenomeDef genomeDefOf(const json::Value& g, const std::string& where) {
    GenomeDef def;
    def.R = json::asInt(json::member(g, "R", where), where + ".R");
    def.D = json::asInt(json::member(g, "D", where), where + ".D");
    def.L = json::intArray(json::member(g, "L", where), where + ".L");
    def.Z = json::intArray(json::member(g, "Z", where), where + ".Z");
    for (const auto& t : json::asArray(json::member(g, "T", where), where + ".T")) {
        // load() only passes genomes whose T-children are all references to other collections.
        const std::string tWhere = where + ".T";
        const json::Value* shift = t.find("shift");
        def.T.push_back({json::asString(json::member(t, "name", tWhere), tWhere + ".name"),
                         shift ? json::asInt(*shift, tWhere + ".shift") : 0});
    }
    return def;
}

// True when every T-child is a {name, shift?} reference, i.e. no nested genome tuple.
bool allTNamed(const json::Value& g, const std::string& where) {
    for (const auto& t : json::asArray(json::member(g, "T", where), where + ".T"))
        if (!t.find("name")) return false;
    return true;
}

GenomeDefs load() {
    try {
        const json::Value& doc = collectionElementsJson();
        GenomeDefs defs;
        defs.maxShift = json::asInt(json::member(doc, "maxShift", "root"), "maxShift");
        defs.maxFoldDepth = json::asInt(json::member(doc, "maxFoldDepth", "root"), "maxFoldDepth");
        for (const auto& c : json::asArray(json::member(doc, "collections", "root"), "collections")) {
            const std::string& name = json::asString(json::member(c, "name", "collection"), "collection.name");
            const json::Value* genome = c.find("genome");
            if (!genome) continue;  // double-crit (Z_n) collections carry no genome
            if (!allTNamed(*genome, name + ".genome")) continue;  // display-only, see genome_defs.hpp
            defs.families.emplace_back(name, genomeDefOf(*genome, name + ".genome"));
        }
        return defs;
    } catch (const std::runtime_error& e) {
        throw std::runtime_error(std::string("genome_defs: ") + e.what());
    }
}

}  // namespace

const GenomeDefs& genomeDefs() {
    static const GenomeDefs kDefs = load();
    return kDefs;
}

}  // namespace genome_defs
}  // namespace stalks_tools
