// Ad-hoc debug tool: analyze a single position encoding and dump its children.
// Usage: query_position "<encoding>" [--decompress]
#include "analyze.hpp"
#include "encoding.hpp"
#include "position.hpp"
#include <cstdio>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: query_position <encoding> [--decompress]\n";
        return 1;
    }
    std::string enc = argv[1];
    if (argc >= 3 && std::string(argv[2]) == "--decompress") {
        stalks::Position p = stalks::parsePosition(enc);
        stalks::Position d = p.decompressed();
        std::cout << stalks::serialize(d) << "\n";
        return 0;
    }
    if (argc >= 3 && std::string(argv[2]) == "--children-tracked") {
        std::cout << stalks::childrenTrackedJson(enc) << "\n";
        return 0;
    }
    if (argc >= 6 && std::string(argv[2]) == "--region-moves") {
        const int comp = std::atoi(argv[3]);
        const int region = std::atoi(argv[4]);
        const int boundary = std::atoi(argv[5]);
        const int token = std::atoi(argv[6]);
        std::cout << stalks::regionMovesTrackedJson(enc, comp, region, boundary, token) << "\n";
        return 0;
    }
    std::string result = stalks::analyzeFullJson(enc);
    std::cout << result << "\n";
    return 0;
}
