#include "position.hpp"

#include "unionfind.hpp"

#include <algorithm>
#include <map>

namespace stalks {

std::vector<std::vector<std::vector<int>>> Component::pairIndex() const {
    const Component& c = *this;
    std::vector<std::vector<std::vector<int>>> idx(c.regions.size());
    for (size_t r = 0; r < c.regions.size(); ++r) {
        idx[r].resize(c.regions[r].size());
        for (size_t b = 0; b < c.regions[r].size(); ++b) {
            const auto membs = std::count(c.regions[r][b].begin(), c.regions[r][b].end(), MEMB);
            idx[r][b].assign(static_cast<size_t>(membs), -1);
        }
    }
    auto slot = [&](const MRef& m) -> int& {
        if (m.region >= idx.size() || m.boundary >= idx[m.region].size() ||
            m.occ >= idx[m.region][m.boundary].size())
            throw EncodingError("membrane reference out of range");
        return idx[m.region][m.boundary][m.occ];
    };
    for (size_t k = 0; k < c.pairings.size(); ++k) {
        const auto& [a, b] = c.pairings[k];
        if (a.region == b.region)
            throw EncodingError("membrane links a region to itself");
        int& sa = slot(a);
        int& sb = slot(b);
        if (sa != -1 || sb != -1)
            throw EncodingError("membrane occurrence used in more than one pairing");
        sa = static_cast<int>(k);
        sb = static_cast<int>(k);
    }
    return idx;
}

int Component::lives2() const {
    if (dead)
        return 0;
    int total = 0;
    for (const auto& reg : regions)
        for (const auto& b : reg)
            total += stalks::lives2(b);
    return total;
}

void Component::validate() const {
    if (dead) {
        if (!regions.empty() || !pairings.empty())
            throw EncodingError("dead component (phi) must not contain regions or pairings");
        return;
    }
    if (regions.empty())
        throw EncodingError("component has no regions");
    for (const auto& reg : regions) {
        if (reg.empty())
            throw EncodingError("region has no boundaries");
        for (const auto& b : reg) {
            if (b.empty())
                throw EncodingError("empty boundary");
            validateJoints(b);
        }
    }

    pairIndex();  // throws on pairing inconsistencies

    // Body-part reachability rule: walk from body part to body part through paired
    // membranes; two distinct body parts in the same region must never be connected.
    // Nodes are (region, boundary, bodyPart) triples that host at least one paired
    // membrane; pairings are edges; violations are two distinct nodes of one region in
    // one connected component.
    std::vector<std::vector<std::vector<int>>> partOfOcc(regions.size());
    for (size_t r = 0; r < regions.size(); ++r) {
        partOfOcc[r].resize(regions[r].size());
        for (size_t b = 0; b < regions[r].size(); ++b) {
            const auto parts = bodyParts(regions[r][b]);
            for (size_t i = 0; i < regions[r][b].size(); ++i)
                if (regions[r][b][i] == MEMB)
                    partOfOcc[r][b].push_back(parts[i]);
        }
    }
    std::map<std::tuple<std::uint32_t, std::uint32_t, int>, int> nodeIds;
    auto nodeOf = [&](const MRef& m) {
        const int part = partOfOcc[m.region][m.boundary][m.occ];
        const auto key = std::make_tuple(m.region, m.boundary, part);
        const auto [it, _] = nodeIds.try_emplace(key, static_cast<int>(nodeIds.size()));
        return it->second;
    };
    std::vector<std::tuple<std::uint32_t, std::uint32_t, int>> nodeKeys;
    std::vector<std::pair<int, int>> edges;
    for (const auto& [a, b] : pairings)
        edges.emplace_back(nodeOf(a), nodeOf(b));
    nodeKeys.resize(nodeIds.size());
    for (const auto& [key, id] : nodeIds)
        nodeKeys[static_cast<size_t>(id)] = key;

    UnionFind uf(nodeIds.size());
    for (const auto& [a, b] : edges)
        uf.unite(a, b);

    // root -> (region -> representative node)
    std::map<std::pair<int, std::uint32_t>, int> seen;
    for (int id = 0; id < static_cast<int>(nodeKeys.size()); ++id) {
        const auto& [region, boundary, part] = nodeKeys[static_cast<size_t>(id)];
        const auto key = std::make_pair(uf.find(id), region);
        const auto [it, inserted] = seen.try_emplace(key, id);
        if (!inserted && it->second != id)
            throw EncodingError(
                "invalid position: two distinct body parts in one region are "
                "membrane-connected (not drawable as a planar graph)");
    }
}

Component Component::decompressed() const {
    if (dead)
        return *this;

    Component out;
    out.regions.resize(regions.size());
    std::vector<std::vector<Bnd>> extra;  // interior regions, appended after existing ones
    std::vector<std::pair<MRef, MRef>> newPairings;
    // occMap[r][b][oldOcc] = occ of the same membrane in the rewritten boundary
    std::vector<std::vector<std::vector<std::uint32_t>>> occMap(regions.size());

    for (std::uint32_t r = 0; r < regions.size(); ++r) {
        occMap[r].resize(regions[r].size());
        out.regions[r].reserve(regions[r].size());
        for (std::uint32_t b = 0; b < regions[r].size(); ++b) {
            Bnd nb;
            std::uint32_t occ = 0;
            auto& omap = occMap[r][b];
            for (Token t : regions[r][b]) {
                switch (t) {
                    case MEMB:
                        omap.push_back(occ++);
                        nb.push_back(MEMB);
                        break;
                    case DISA: {
                        const auto nr =
                            static_cast<std::uint32_t>(regions.size() + extra.size());
                        extra.push_back({Bnd{SCAB, MEMB}});
                        newPairings.push_back({{r, b, occ}, {nr, 0, 0}});
                        nb.push_back(MEMB);
                        ++occ;
                        break;
                    }
                    case HOLL: {
                        const auto nr =
                            static_cast<std::uint32_t>(regions.size() + extra.size());
                        extra.push_back({Bnd{MEMB, MEMB}});
                        newPairings.push_back({{r, b, occ}, {nr, 0, 0}});
                        newPairings.push_back({{r, b, occ + 1}, {nr, 0, 1}});
                        nb.push_back(MEMB);
                        nb.push_back(MEMB);
                        occ += 2;
                        break;
                    }
                    case SPLIT: {
                        const auto nr1 =
                            static_cast<std::uint32_t>(regions.size() + extra.size());
                        extra.push_back({Bnd{MEMB, MEMB}});
                        const auto nr2 = nr1 + 1;
                        extra.push_back({Bnd{MEMB, MEMB}});
                        newPairings.push_back({{r, b, occ}, {nr1, 0, 0}});
                        newPairings.push_back({{r, b, occ + 1}, {nr2, 0, 0}});
                        newPairings.push_back({{nr1, 0, 1}, {nr2, 0, 1}});
                        nb.push_back(MEMB);
                        nb.push_back(MEMB);
                        occ += 2;
                        break;
                    }
                    case TRIP: {
                        const auto nr =
                            static_cast<std::uint32_t>(regions.size() + extra.size());
                        extra.push_back({Bnd{MEMB, MEMB, MEMB}});
                        for (std::uint32_t i = 0; i < 3; ++i)
                            newPairings.push_back({{r, b, occ + i}, {nr, 0, i}});
                        nb.append(3, MEMB);
                        occ += 3;
                        break;
                    }
                    default:
                        nb.push_back(t);
                        break;
                }
            }
            out.regions[r].push_back(std::move(nb));
        }
    }

    for (auto& reg : extra)
        out.regions.push_back(std::move(reg));

    out.pairings.reserve(pairings.size() + newPairings.size());
    for (const auto& [a, b] : pairings) {
        const MRef na{a.region, a.boundary, occMap[a.region][a.boundary][a.occ]};
        const MRef nnb{b.region, b.boundary, occMap[b.region][b.boundary][b.occ]};
        out.pairings.push_back({na, nnb});
    }
    out.pairings.insert(out.pairings.end(), newPairings.begin(), newPairings.end());
    return out;
}

int Position::lives2() const {
    int total = 0;
    for (const auto& c : components)
        total += c.lives2();
    return total;
}

void Position::validate() const {
    if (components.empty())
        throw EncodingError("position has no components");
    for (const auto& c : components)
        c.validate();
}

Position Position::decompressed() const {
    Position out;
    out.components.reserve(components.size());
    for (const auto& c : components)
        out.components.push_back(c.decompressed());
    return out;
}

} // namespace stalks
