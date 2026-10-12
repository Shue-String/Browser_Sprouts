// Which EXISTING collection (if any) does each candidate left side belong to? Runs every candidate
// through three independent membership checks against the live registry
// (src/data/collectionElements.json), so they can be compared side by side:
//
//   1. reducesTo   -- does the current registry already reduce it? quickCanon() of the candidate,
//                     matched against every collection's own quickCanon'd rep; reported as the
//                     collection name plus the reduction's offset ("S_5", "S_7⊕1"). Empty = the
//                     registry doesn't cover it today.
//   2. yellow      -- the Yellow Line test: every named family (S_1-S_32 at every shift, see
//                     allNamedFamilyNames) for which isYellowCandidate() says YES. Only covers the
//                     hand-authored families -- S_33+ have no declared required T-genes to test.
//   3. genomeMatch -- the backup test: every collection whose stored genome (collectionElements.json
//                     "genome", T deduped) equals the candidate's own rootGenomeText exactly (after
//                     naming any nested T genome that is some collection's genome, as the JSON does). Covers
//                     every collection that has a stored genome, but only at offset 0 (offset groups'
//                     genomes aren't stored).
// Also reports the candidate's genome text and its resolvedGenomeName (its exact fold, if any).
//
// Usage: classify_candidates <candidates.txt> [out.tsv]
//   candidates.txt: one left-side encoding per line (registry convention, crit port 'a'; pasted
//   "[...]/" decoration and Greek alpha are accepted, see toEmbeddable). Blank lines and lines
//   starting with '#' are skipped. Only single-crit (k=1) candidates are checked; others are SKIP.
#include "alpha_genome.hpp"
#include "canon.hpp"
#include "collections.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "json.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;
using namespace stalks_tools;

namespace {

constexpr int kMaxLives2 = 32;  // 16 lives -- same gate as genome_for_reps / analyze.cpp

int maxSubLives2(const Position& p) {
    int m = 0;
    for (const auto& comp : p.components) m = std::max(m, comp.lives2());
    return m;
}

std::string intSetText(const json::Value& arr, const std::string& where) {
    const std::vector<int> values = json::intArray(arr, where);
    std::string out;
    for (int v : std::set<int>(values.begin(), values.end())) out += (out.empty() ? "" : ",") + std::to_string(v);
    return out;
}

// A stored collectionElements.json genome as "(R,D,{L},{Z},[T])" text -- the same shape
// rootGenomeText/fullGenomeText produce: T deduped and sorted, a named T-child as "S_n" / "S_n⊕k",
// a nested genome recursively.
std::string storedGenomeText(const json::Value& g, const std::string& where) {
    std::string head = "(" + std::to_string(json::asInt(json::member(g, "R", where), where)) + "," +
                       std::to_string(json::asInt(json::member(g, "D", where), where)) + ",{" +
                       intSetText(json::member(g, "L", where), where) + "},{" +
                       intSetText(json::member(g, "Z", where), where) + "}";
    const json::Value* T = g.find("T");
    if (!T) return head + ")";
    std::set<std::string> children;
    for (const auto& t : json::asArray(*T, where + ".T")) {
        if (const json::Value* name = t.find("name")) {
            const json::Value* shift = t.find("shift");
            const int k = shift ? json::asInt(*shift, where) : 0;
            children.insert(json::asString(*name, where) + (k ? "\xE2\x8A\x95" + std::to_string(k) : ""));
        } else {
            children.insert(storedGenomeText(t, where + ".T"));
        }
    }
    std::string joined;
    for (const auto& c : children) joined += (joined.empty() ? "" : ",") + c;
    return head + ",[" + joined + "])";
}

// `text` with every nested T genome whose text equals some collection's stored genome replaced by
// that collection's name (T then re-deduped and re-sorted) -- the same naming
// scripts/collectionsJson.cjs's nameKnownGenomes applies to the stored genomes, so engine output
// (which names a T-child only via registry reduction) compares like-for-like against them.
std::string nameKnownGenomes(const std::string& text, const std::map<std::string, std::string>& nameByText) {
    const std::size_t open = text.find(",[");
    if (open == std::string::npos) return text;
    const std::string inner = text.substr(open + 2, text.size() - open - 4);  // between ",[" and "])"
    std::set<std::string> items;
    int depth = 0;
    std::string cur;
    auto flush = [&] {
        if (cur.empty()) return;
        std::string item = cur[0] == '(' ? nameKnownGenomes(cur, nameByText) : cur;
        const auto it = nameByText.find(item);
        items.insert(it != nameByText.end() ? it->second : item);
        cur.clear();
    };
    for (char ch : inner) {
        if (ch == '(' || ch == '[' || ch == '{') ++depth;
        if (ch == ')' || ch == ']' || ch == '}') --depth;
        if (ch == ',' && depth == 0) flush();
        else cur += ch;
    }
    flush();
    std::string joined;
    for (const auto& i : items) joined += (joined.empty() ? "" : ",") + i;
    return text.substr(0, open) + ",[" + joined + "])";
}

struct Collection {
    std::string name;
    std::string repQuick;    // serialize(quickCanon("[rep]").rep), "" for a non-single-crit rep
    std::string genomeText;  // "" when the collection has no stored genome
};

std::vector<Collection> loadCollections() {
    std::vector<Collection> out;
    for (const auto& c : json::asArray(json::member(collectionElementsJson(), "collections", "root"), "collections")) {
        Collection col;
        col.name = json::asString(json::member(c, "name", "collection"), "collection.name");
        const std::string& rep = json::asString(json::member(c, "rep", col.name), col.name + ".rep");
        if (distinctPortLetters(rep) == 1) col.repQuick = serialize(quickCanon(parsePosition("[" + rep + "]")).rep);
        if (const json::Value* g = c.find("genome")) col.genomeText = storedGenomeText(*g, col.name + ".genome");
        out.push_back(std::move(col));
    }
    return out;
}

std::string joinNames(const std::vector<std::string>& v) {
    std::string out;
    for (const auto& s : v) out += (out.empty() ? "" : ",") + s;
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: classify_candidates <candidates.txt> [out.tsv]\n";
        return 1;
    }
    const std::string outPath = argc >= 3 ? argv[2] : "classify_candidates.tsv";

    std::vector<std::string> candidates;
    {
        std::ifstream in(argv[1]);
        if (!in) {
            std::cerr << "cannot open " << argv[1] << "\n";
            return 1;
        }
        std::string line;
        while (std::getline(in, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            const std::size_t start = line.find_first_not_of(" \t");
            if (start == std::string::npos || line[start] == '#') continue;
            candidates.push_back(line.substr(start));
        }
    }
    std::cerr << "candidates: " << candidates.size() << "\n";

    const std::vector<Collection> collections = loadCollections();
    std::map<std::string, std::string> nameByText;  // stored genome text -> collection name
    for (const auto& c : collections)
        if (!c.genomeText.empty()) nameByText.emplace(c.genomeText, c.name);
    const std::vector<std::string> families = allNamedFamilyNames();
    std::cerr << "collections: " << collections.size() << ", named families (all shifts): " << families.size() << "\n";

    struct Row {
        std::string raw;
        std::string skip;  // non-empty = reason this candidate wasn't checked
        Position pos;
    };
    std::vector<Row> rows;
    GameGraph g(GameGraph::Mode::Exact);
    std::vector<const Node*> roots;
    for (const std::string& raw : candidates) {
        Row r{raw, "", {}};
        const std::string cleaned = toEmbeddable(raw);
        if (distinctPortLetters(cleaned) != 1) {
            r.skip = "(SKIP: not single-crit)";
        } else {
            try {
                r.pos = canonicalize(parsePosition("[" + cleaned + "]"));
                if (maxSubLives2(r.pos) > kMaxLives2) r.skip = "(SKIP: too large)";
                else roots.push_back(g.ensure(r.pos));
            } catch (const EncodingError& e) {
                r.skip = std::string("(SKIP: parse error: ") + e.what() + ")";
            }
        }
        rows.push_back(std::move(r));
    }
    std::cerr << "solved " << roots.size() << "/" << candidates.size() << " candidates\n";

    std::stringstream specStream;
    saveSpecGraph(g, roots, specStream);
    const SpecDB db = loadSpecGraph(specStream);
    std::cerr << "in-memory SpecDB: " << db.size() << " nodes\n";

    std::ofstream out(outPath);
    out << "candidate\treducesTo\tyellow\tgenomeMatch\tresolvedName\tgenome\n";
    int reduced = 0, yellowAny = 0, genomeAny = 0, none = 0, skipped = 0;
    for (const Row& r : rows) {
        if (!r.skip.empty()) {
            out << r.raw << "\t" << r.skip << "\t\t\t\t\n";
            ++skipped;
            continue;
        }
        const QuickCanonResult qc = quickCanon(r.pos);
        const std::string quickEnc = serialize(qc.rep);
        std::vector<std::string> reducesTo;
        for (const auto& c : collections)
            if (!c.repQuick.empty() && c.repQuick == quickEnc)
                reducesTo.push_back(qc.offset ? c.name + "\xE2\x8A\x95" + std::to_string(qc.offset) : c.name);

        std::vector<std::string> yellow;
        for (const std::string& family : families)
            if (isYellowCandidate(r.pos, db, family)) yellow.push_back(family);

        const std::string genome = nameKnownGenomes(rootGenomeText(r.pos, db), nameByText);
        std::vector<std::string> genomeMatch;
        for (const auto& c : collections)
            if (!c.genomeText.empty() && c.genomeText == genome) genomeMatch.push_back(c.name);

        const auto resolved = resolvedGenomeName(r.pos, db);
        out << r.raw << "\t" << joinNames(reducesTo) << "\t" << joinNames(yellow) << "\t" << joinNames(genomeMatch)
            << "\t" << (resolved ? *resolved : "") << "\t" << genome << "\n";

        if (!reducesTo.empty()) ++reduced;
        if (!yellow.empty()) ++yellowAny;
        if (!genomeMatch.empty()) ++genomeAny;
        if (reducesTo.empty() && yellow.empty() && genomeMatch.empty()) ++none;
    }
    std::cerr << candidates.size() << " candidates: " << reduced << " already reduce, " << yellowAny
              << " pass Yellow Line, " << genomeAny << " match a stored genome, " << none
              << " match nothing, " << skipped << " skipped\nwrote " << outPath << "\n";
    return 0;
}
