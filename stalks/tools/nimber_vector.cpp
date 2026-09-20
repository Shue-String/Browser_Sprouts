// Ad-hoc research tool: for every left-side encoding in an input file, compute the EXACT
// (structural, registry-independent) nimber of that left side embedded against several fixed
// hosts, sharing one GameGraph across the whole run for memoization. Used to test whether two
// registered families' reps are offset-siblings of each other (constant XOR difference across
// every host) without knowing the offset in advance -- verify_left_side.exe requires a known
// expectedOffset per call, which doesn't scale to an unguided N-vs-M sweep across many reps.
//
// Usage: nimber_vector <encodings.txt> [out.tsv]
// encodings.txt: one left-side encoding per line (bracket/slash-free, port letter 'a'-'z').
// Writes out.tsv (default nimber_vector.tsv): encoding \t nimber@host1 \t nimber@host2 ...
#include "canon.hpp"
#include "encoding.hpp"
#include "graph.hpp"
#include "position.hpp"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace stalks;

namespace {

std::string toEmbeddable(const std::string& raw) {
    std::string out;
    for (char ch : raw) {
        if (ch == '[' || ch == ']' || ch == '/' || ch == ' ' || ch == '\t' || ch == '\r')
            continue;
        out.push_back((ch >= 'a' && ch <= 'z') ? 'Z' : ch);
    }
    return out;
}

int exactNimber(GameGraph& g, const std::string& posText) {
    Position p = canonicalize(parsePosition(posText));
    return g.ensure(p)->nimber;
}

const std::vector<std::string> kDefaultHosts = {"0,Z", "0,0,Z", "1Z", "1,1Z", "22,Z", "0Z", "2Z", "3,Z"};

// Semicolon-separated, same convention as verify_left_side.cpp's STALKS_VERIFY_HOSTS.
std::vector<std::string> hostsFromEnv() {
    const char* v = std::getenv("STALKS_VERIFY_HOSTS");
    if (!v || !v[0])
        return kDefaultHosts;
    std::vector<std::string> out;
    std::stringstream ss(v);
    std::string tok;
    while (std::getline(ss, tok, ';'))
        if (!tok.empty())
            out.push_back(tok);
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: nimber_vector <encodings.txt> [out.tsv]\n";
        return 1;
    }
    const std::string outPath = argc >= 3 ? argv[2] : "nimber_vector.tsv";
    std::ifstream in(argv[1]);
    if (!in) {
        std::cerr << "cannot open " << argv[1] << "\n";
        return 1;
    }
    const std::vector<std::string> hosts = hostsFromEnv();
    std::ofstream out(outPath);
    out << "encoding";
    for (const auto& h : hosts) out << "\t" << h;
    out << "\n";

    GameGraph g(GameGraph::Mode::Exact);
    std::string line;
    int count = 0, errors = 0;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        const auto t0 = std::chrono::steady_clock::now();
        const std::string embeddable = toEmbeddable(line);
        out << line;
        for (const auto& h : hosts) {
            try {
                out << "\t" << exactNimber(g, embeddable + "|" + h);
            } catch (const std::exception&) {
                out << "\tERR";
                ++errors;
            }
        }
        out << "\n";
        out.flush();
        ++count;
        const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::cerr << "  [" << count << "] " << line << "  (" << secs << "s)\n";
        std::cerr.flush();
    }
    std::cerr << count << " encodings processed, " << errors << " nimber errors. wrote " << outPath
               << "\n";
    return 0;
}
