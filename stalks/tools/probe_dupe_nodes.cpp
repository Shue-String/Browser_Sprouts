// One-off diagnostic: does a .spec file's own db.nodes() contain more than one SpecNode sharing
// the identical .enc string? merge_specs.cpp is supposed to dedup by encoding across input files
// (see its own encToGlobal map), so a properly-merged file should have zero -- this checks that
// claim directly instead of assuming it holds.
// Usage: probe_dupe_nodes <spec1.spec> [spec2.spec ...]
#include "specfile.hpp"

#include <iostream>
#include <map>
#include <string>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: probe_dupe_nodes <spec1.spec> [spec2.spec ...]\n";
        return 1;
    }
    for (int i = 1; i < argc; ++i) {
        const std::string path = argv[i];
        SpecDB db = loadSpecGraphFromFile(path);
        std::map<std::string, int> cnt;
        for (const SpecNode& n : db.nodes()) ++cnt[n.enc];
        long long dupGroups = 0, totalDupNodes = 0;
        for (const auto& [k, v] : cnt) {
            if (v > 1) { ++dupGroups; totalDupNodes += v; }
        }
        std::cerr << path << ": " << db.nodes().size() << " total nodes, " << cnt.size()
                  << " distinct encodings, " << dupGroups
                  << " encodings appear more than once (covering " << totalDupNodes
                  << " raw node entries)\n";
        int shown = 0;
        for (const auto& [k, v] : cnt) {
            if (v > 1 && shown < 8) {
                std::cerr << "  x" << v << ": '" << k << "'\n";
                ++shown;
            }
        }
    }
    return 0;
}
