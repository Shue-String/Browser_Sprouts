#include "boundary.hpp"

#include <algorithm>
#include <unordered_map>

namespace stalks {

std::vector<std::pair<int, int>> jointPairs(const Bnd& b) {
    std::vector<std::pair<int, int>> pairs;
    std::vector<int> stack;
    for (int i = 0; i < static_cast<int>(b.size()); ++i) {
        if (b[i] == JOINTSTART) {
            stack.push_back(static_cast<int>(pairs.size()));
            pairs.push_back({i, -1});
        } else if (b[i] == JOINTEND) {
            if (stack.empty())
                throw EncodingError("unmatched joint-end (8) in boundary");
            pairs[stack.back()].second = i;
            stack.pop_back();
        }
    }
    if (!stack.empty())
        throw EncodingError("unmatched joint-start (7) in boundary");
    return pairs;
}

void validateJoints(const Bnd& b) {
    const auto pairs = jointPairs(b);
    const int n = static_cast<int>(b.size());
    for (const auto& [open, close] : pairs) {
        const bool adjacentForward = (close == open + 1);
        const bool adjacentWrapped = (open == 0 && close == n - 1);
        if (adjacentForward || adjacentWrapped)
            throw EncodingError(
                "joint with nothing between its two visits; encode it as a scab (2)");
    }
}

namespace {

// A walk with joint tokens tagged by pair id (-1 for non-joint tokens).
using TaggedWalk = std::vector<std::pair<Token, int>>;

TaggedWalk withIds(const Bnd& b) {
    const auto pairs = jointPairs(b);
    std::vector<int> idAt(b.size(), -1);
    for (int k = 0; k < static_cast<int>(pairs.size()); ++k) {
        idAt[pairs[k].first] = k;
        idAt[pairs[k].second] = k;
    }
    TaggedWalk walk(b.size());
    for (size_t i = 0; i < b.size(); ++i)
        walk[i] = {b[i], idAt[i]};
    return walk;
}

Bnd reemit(const TaggedWalk& walk) {
    Bnd out;
    out.reserve(walk.size());
    std::unordered_map<int, bool> seen;
    for (const auto& [tok, id] : walk) {
        if (id < 0)
            out.push_back(tok);
        else if (!seen[id]) {
            seen[id] = true;
            out.push_back(JOINTSTART);
        } else {
            out.push_back(JOINTEND);
        }
    }
    return out;
}

} // namespace

Bnd rotated(const Bnd& b, int shift) {
    if (b.size() < 2)
        return b;
    const int n = static_cast<int>(b.size());
    shift = ((shift % n) + n) % n;
    auto walk = withIds(b);
    std::rotate(walk.begin(), walk.begin() + shift, walk.end());
    return reemit(walk);
}

Bnd mirrored(const Bnd& b) {
    auto walk = withIds(b);
    std::reverse(walk.begin(), walk.end());
    return reemit(walk);
}

Bnd canonicalRotation(const Bnd& b, int* outShift) {
    Bnd best = rotated(b, 0);
    int bestShift = 0;
    for (int s = 1; s < static_cast<int>(b.size()); ++s) {
        Bnd r = rotated(b, s);
        if (r < best) {
            best = std::move(r);
            bestShift = s;
        }
    }
    if (outShift)
        *outShift = bestShift;
    return best;
}

std::vector<int> canonicalShifts(const Bnd& b) {
    const Bnd canon = canonicalRotation(b);
    std::vector<int> shifts;
    const int n = std::max<int>(1, static_cast<int>(b.size()));
    for (int s = 0; s < n; ++s)
        if (rotated(b, s) == canon)
            shifts.push_back(s);
    return shifts;
}

std::vector<int> bodyParts(const Bnd& b) {
    std::vector<int> ids(b.size());
    std::vector<int> stack{0};
    int next = 1;
    for (size_t i = 0; i < b.size(); ++i) {
        if (b[i] == JOINTSTART) {
            stack.push_back(next++);
            ids[i] = stack.back();
        } else if (b[i] == JOINTEND) {
            if (stack.size() <= 1)
                throw EncodingError("unbalanced joints in bodyParts");
            ids[i] = stack.back();
            stack.pop_back();
        } else {
            ids[i] = stack.back();
        }
    }
    if (stack.size() != 1)
        throw EncodingError("unbalanced joints in bodyParts");
    return ids;
}

int lives2(const Bnd& b) {
    int total = 0;
    for (Token t : b)
        total += lives2(t);
    return total;
}

} // namespace stalks
