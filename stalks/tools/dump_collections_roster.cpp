// Offline tool: dump every currently-registered Advanced Collection roster (collections.cpp's
// registry()/doubleCritRegistry(), exposed via allCollectionRosters() -- see collections.hpp) to
// JSON, for the Collect pane's Collections panel (src/data/collectionsRoster.json). This is the
// single source of truth for that panel's static reference rosters: whenever a roster in
// collections.cpp is edited (elements added/removed, a whole new collection registered), rerun
// this tool and the TS side picks up the change with no hand-copied duplicate list to keep in
// sync.
//
// Usage: dump_collections_roster <out.json>

#include "collections.hpp"

#include <fstream>
#include <iostream>
#include <string>

using namespace stalks;

namespace {

// The left-side encoding alphabet (digits, 'a'-'z' ports, ',', whitespace/bracket punctuation --
// see collections.cpp's parseLeftSide) never contains a quote or backslash, so these strings need
// no JSON escaping.
void writeStringArray(std::ofstream& f, const std::vector<std::string>& vals) {
    f << "[";
    for (std::size_t i = 0; i < vals.size(); ++i) {
        if (i) f << ",";
        f << "\"" << vals[i] << "\"";
    }
    f << "]";
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: dump_collections_roster <out.json>\n";
        return 1;
    }
    const std::string outPath = argv[1];

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }

    const std::vector<CollectionRoster> rosters = allCollectionRosters();
    f << "{\"collections\":[";
    for (std::size_t i = 0; i < rosters.size(); ++i) {
        if (i) f << ",";
        const CollectionRoster& r = rosters[i];
        f << "{\"name\":\"" << r.name << "\",\"offset\":" << r.offset << ",\"elements\":";
        writeStringArray(f, r.elements);
        f << ",\"rep\":\"" << r.rep << "\"}";
    }
    f << "]}";

    std::cerr << "wrote " << rosters.size() << " collection rosters to " << outPath << "\n";
    return 0;
}
