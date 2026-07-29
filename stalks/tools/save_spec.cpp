// Build one Exact GameGraph rooted at each given encoding (sharing the graph across all of them,
// so common subpositions are computed once) and save the COMBINED tree -- every node reachable from
// ANY of the roots -- to one .spec file (specfile.hpp/cpp). Reloads and re-checks each root's value
// against the live graph before reporting success, mirroring the .sprout master-file build harness's
// own "reload + re-check before moving on" verification.
//
// Usage: save_spec <out.spec> <enc1> [enc2 ...]
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"
#include "specfile.hpp"

#include <iostream>
#include <string>
#include <vector>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: save_spec <out.spec> <enc1> [enc2 ...]\n";
        return 1;
    }
    const std::string outPath = argv[1];
    std::vector<std::string> encs;
    for (int i = 2; i < argc; ++i)
        encs.push_back(argv[i]);

    try {
        GameGraph g;  // Exact mode (default), shared across every root
        std::vector<const Node*> roots;
        for (const std::string& enc : encs) {
            Node* root = g.ensure(parsePosition(enc));
            roots.push_back(root);
            std::cout << "root " << enc << " -> canon " << root->enc << "  nimber=" << root->nimber
                      << " minMoves=" << root->minMoves << " maxMoves=" << root->maxMoves << "\n";
        }

        const std::size_t written = saveSpecGraphToFile(g, roots, outPath);
        std::cout << "wrote " << written << " minimal nodes to " << outPath << "\n";

        const SpecDB db = loadSpecGraphFromFile(outPath);
        std::cout << "reloaded " << db.size() << " nodes; verifying...\n";
        bool ok = (db.size() == written);
        if (!ok)
            std::cout << "FAIL: node count mismatch\n";
        for (std::size_t i = 0; i < encs.size(); ++i) {
            SpecValue v;
            const bool found = db.value(parsePosition(encs[i]), v);
            if (!found) {
                std::cout << "FAIL: root " << encs[i] << " not found in reloaded DB\n";
                ok = false;
                continue;
            }
            const Node* root = roots[i];
            const bool match =
                v.nimber == root->nimber && v.minMoves == root->minMoves && v.maxMoves == root->maxMoves;
            std::cout << (match ? "PASS" : "FAIL") << ": root " << encs[i] << " round-trip value nimber="
                      << v.nimber << " minMoves=" << v.minMoves << " maxMoves=" << v.maxMoves << "\n";
            ok = ok && match;
        }
        std::cout << (ok ? "OK\n" : "VERIFICATION FAILED\n");
        return ok ? 0 : 1;
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
}
