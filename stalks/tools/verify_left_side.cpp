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

// `g` is shared across the whole run (see main()) rather than built fresh per call: GameGraph
// memoizes every node it builds by canonical position (graph.cpp's `index_`), so a single shared
// instance means the same rep|host position -- recomputed identically for every candidate in a
// family, since the rep and host set never change within one run -- and any overlapping subtree
// between different candidates' positions are each solved ONCE, not once per call. A fresh
// GameGraph per call (the old behavior) threw all of that reuse away, forcing the exact same
// rep|host solve from scratch hundreds of times over for a large family.
int exactNimber(GameGraph& g, const std::string& posText) {
    Position p = canonicalize(parsePosition(posText));
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
    const int total = argc - 3;

    // One graph for the whole run -- see exactNimber's own doc comment for why this matters.
    GameGraph g(GameGraph::Mode::Exact);

    // Progress heartbeat, per candidate AND per host: a single candidate can take well over a
    // minute across a few hosts (the joint-bearing STALKS_VERIFY_HOSTS battery especially), so
    // printing only the final PASS/FAIL line leaves long silent stretches with no way to tell a
    // slow-but-alive run from a hung one. Both lines are flushed immediately, so a caller tailing
    // this process's stdout (even redirected to a file) sees live progress, not a batch dump at exit.
    int failCount = 0;
    for (int i = 3; i < argc; ++i) {
        const int idx = i - 2;  // 1-based position among the candidates on this invocation
        const std::string cand = toEmbeddable(argv[i]);
        std::cout << "[" << idx << "/" << total << "] testing " << argv[i] << " ("
                   << hosts.size() << " hosts)...\n";
        std::cout.flush();
        std::vector<std::string> mismatches;
        const auto t0 = std::chrono::steady_clock::now();
        for (std::size_t h = 0; h < hosts.size(); ++h) {
            const auto& host = hosts[h];
            const auto hostT0 = std::chrono::steady_clock::now();
            int repN = -1, candN = -1;
            bool hostFailed = false;
            try {
                repN = exactNimber(g, rep + "|" + host);
                candN = exactNimber(g, cand + "|" + host);
            } catch (const std::exception& e) {
                mismatches.push_back(host + ": ERROR " + e.what());
                hostFailed = true;
            }
            const double hostSecs = std::chrono::duration<double>(std::chrono::steady_clock::now() - hostT0).count();
            if (!hostFailed && candN != (repN ^ expectedOffset)) {
                mismatches.push_back(host + ": rep=" + std::to_string(repN) +
                                      " cand=" + std::to_string(candN) +
                                      " (want cand==" + std::to_string(repN ^ expectedOffset) + ")");
                hostFailed = true;
            }
            std::cout << "    host " << (h + 1) << "/" << hosts.size() << " \"" << host
                       << "\": " << (hostFailed ? "mismatch" : "ok") << "  (" << hostSecs << "s)\n";
            std::cout.flush();
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
