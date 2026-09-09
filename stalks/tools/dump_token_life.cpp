// Offline tool: emit public/token_life.generated.json, mapping each plain vertex-token's own
// encoding char ('0'-'6', SPOT..TRIP -- see tokens.hpp) to its leftSideLives2()/2 value. This is
// the single source of truth for src/model/ttree.ts's TOKEN_LIFE table, which the T-Tree pane
// fetches this file into instead of hand-typing the mirror (see ttree.ts's TOKEN_LIFE doc comment
// and project_parallel_structure_refactor_backlog.md item 6). Special-point letters ('a'-'j') and
// delimiters aren't plain tokens and are intentionally omitted -- ttree.ts treats any char missing
// from the table as contributing 0 life.
//
// Usage: dump_token_life <out.json>
// Takes no input files -- the table is a pure function of tokens.hpp, so this always emits the
// current values; re-run and commit the output whenever leftSideLives2() changes.

#include "json_util.hpp"
#include "tokens.hpp"

#include <fstream>
#include <iostream>
#include <string>

using namespace stalks;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: dump_token_life <out.json>\n";
        return 1;
    }
    const std::string outPath = argv[1];

    std::string out = "{";
    bool first = true;
    for (Token t = SPOT; t <= TRIP; ++t) {
        if (!first) out += ',';
        first = false;
        jsonStr(out, std::string(1, tokenChar(t)));
        out += ":";
        out += std::to_string(leftSideLives2(t) / 2);
    }
    out += "}";

    std::ofstream f(outPath, std::ios::binary);
    if (!f) {
        std::cerr << "cannot open output file: " << outPath << "\n";
        return 1;
    }
    f << out;
    std::cerr << "wrote " << out.size() << " bytes to " << outPath << "\n";
    return 0;
}
