// Ad-hoc research tool: vet a candidate left-side encoding for a collection family by DIRECT
// exact-nimber comparison against the family's rep, across several varied right-side hosts. This
// is the same method that caught the unsound `277a88` CSV row and tested (then correctly flagged
// as insufficient on its own for) `2,3,2a` -- see [[project_advanced_collections]]. It is NOT
// proof of collection membership by itself: passing on this host sample is necessary but not
// sufficient (a genuine member must match on EVERY right side, and a T-gene check is the more
// authoritative test for single-alpha-representable collections) -- it just rules out candidates
// that are outright false, the same way the historical ad-hoc checks did, before anything is
// added to the registry in collections.cpp.
//
// The port ('a'-'z' in left-side syntax; also the internal-membrane convention for multi-region
// chunks, which already uses REAL uppercase letters and is untouched here) is mapped to a single
// unused real membrane 'Z' for embedding into ordinary position syntax; each host is a small
// region text containing exactly one 'Z' to pair with it.
//
// Usage: verify_left_side <repEncoding> <expectedOffset> <candidate1> [<candidate2> ...]
#include "canon.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;

namespace {

std::string toEmbeddable(const std::string& raw) {
    std::string out;
    for (char ch : raw) {
        if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t')
            continue;
        out.push_back((ch >= 'a' && ch <= 'z') ? 'Z' : ch);
    }
    return out;
}

int exactNimber(const std::string& posText) {
    Position p = canonicalize(parsePosition(posText));
    GameGraph g(GameGraph::Mode::Exact);
    return g.ensure(p)->nimber;
}

// Cheap default host set (no joints -- fast even for token-heavy multi-region candidates). A
// richer joint-bearing set ("17.8" pattern, the exact shape that caught the 277a88/S_7 non-
// constant-offset bug on host "0,0,17A8") is available via STALKS_VERIFY_HOSTS for a second,
// pricier pass on candidates that already pass this cheap filter -- some token-heavy candidates
// combined with a joint host can blow up the exact solver's state space badly, so it's kept
// separate rather than run unconditionally.
const std::vector<std::string> kDefaultHosts = {"0,Z", "0,0,Z", "1Z", "1,1Z",
                                                 "22,Z", "0Z", "2Z", "3,Z"};

// Semicolon-separated (not comma -- host text itself uses commas as its boundary separator).
std::vector<std::string> hostsFromEnv() {
    const char* v = std::getenv("STALKS_VERIFY_HOSTS");
    if (!v || !v[0])
        return kDefaultHosts;
    std::vector<std::string> out;
    std::stringstream ss(v);
    std::string item;
    while (std::getline(ss, item, ';'))
        if (!item.empty())
            out.push_back(item);
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 4) {
        std::cerr << "usage: verify_left_side <repEncoding> <expectedOffset> <candidate...>\n";
        return 1;
    }
    const std::string rep = toEmbeddable(argv[1]);
    const int expectedOffset = std::atoi(argv[2]);
    const std::vector<std::string> hosts = hostsFromEnv();

    int failCount = 0;
    for (int i = 3; i < argc; ++i) {
        const std::string cand = toEmbeddable(argv[i]);
        std::vector<std::string> mismatches;
        const auto t0 = std::chrono::steady_clock::now();
        for (const auto& host : hosts) {
            int repN = -1, candN = -1;
            try {
                repN = exactNimber(rep + "|" + host);
                candN = exactNimber(cand + "|" + host);
            } catch (const std::exception& e) {
                mismatches.push_back(host + ": ERROR " + e.what());
                continue;
            }
            if (candN != (repN ^ expectedOffset)) {
                mismatches.push_back(host + ": rep=" + std::to_string(repN) +
                                      " cand=" + std::to_string(candN) +
                                      " (want cand==" + std::to_string(repN ^ expectedOffset) + ")");
            }
        }
        const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        if (mismatches.empty()) {
            std::cout << "PASS  " << argv[i] << "  (" << secs << "s)\n";
        } else {
            std::cout << "FAIL  " << argv[i] << "  (" << secs << "s)\n";
            for (const auto& m : mismatches)
                std::cout << "        " << m << "\n";
            ++failCount;
        }
        std::cout.flush();
    }
    return failCount ? 1 : 0;
}
