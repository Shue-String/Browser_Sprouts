cmake_minimum_required(VERSION 3.20)
project(stalks CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(stalks_core
    src/boundary.cpp
    src/position.cpp
    src/encoding.cpp
    src/moves.cpp
    src/canon.cpp
    src/collections.cpp
    src/graph.cpp
    src/savefile.cpp
    src/specfile.cpp
    src/analyze.cpp
)
target_include_directories(stalks_core PUBLIC src)

add_executable(stalks_tests tests/test_main.cpp)
target_link_libraries(stalks_tests PRIVATE stalks_core)

add_executable(dump_master_meta tools/dump_master_meta.cpp)
target_link_libraries(dump_master_meta PRIVATE stalks_core)

add_executable(dump_child_nimbers tools/dump_child_nimbers.cpp)
target_link_libraries(dump_child_nimbers PRIVATE stalks_core)

add_executable(query_position tools/query_position.cpp)
target_link_libraries(query_position PRIVATE stalks_core)

add_executable(explain_move tools/explain_move.cpp)
target_link_libraries(explain_move PRIVATE stalks_core)

add_executable(query_movetype tools/query_movetype.cpp)
target_link_libraries(query_movetype PRIVATE stalks_core)

add_executable(debug_spec_order tools/debug_spec_order.cpp)
target_link_libraries(debug_spec_order PRIVATE stalks_core)

add_executable(save_spec tools/save_spec.cpp)
target_link_libraries(save_spec PRIVATE stalks_core)

add_executable(verify_spec_count tools/verify_spec_count.cpp)
target_link_libraries(verify_spec_count PRIVATE stalks_core)

add_executable(collect_alpha_genetics tools/collect_alpha_genetics.cpp tools/alpha_genome.cpp)
target_link_libraries(collect_alpha_genetics PRIVATE stalks_core)

add_executable(dump_collections_roster tools/dump_collections_roster.cpp)
target_link_libraries(dump_collections_roster PRIVATE stalks_core)

add_executable(quick_reduction_counts tools/quick_reduction_counts.cpp)
target_link_libraries(quick_reduction_counts PRIVATE stalks_core)

add_executable(verify_left_side tools/verify_left_side.cpp)
target_link_libraries(verify_left_side PRIVATE stalks_core)

add_executable(region_frequency tools/region_frequency.cpp)
target_link_libraries(region_frequency PRIVATE stalks_core)

add_executable(unregistered_left_sides tools/unregistered_left_sides.cpp tools/alpha_genome.cpp)
target_link_libraries(unregistered_left_sides PRIVATE stalks_core)

add_executable(yellow_check tools/yellow_check.cpp tools/alpha_genome.cpp)
target_link_libraries(yellow_check PRIVATE stalks_core)

add_executable(find_yellow_candidates tools/find_yellow_candidates.cpp tools/alpha_genome.cpp)
target_link_libraries(find_yellow_candidates PRIVATE stalks_core)

if(MSVC)
    foreach(tgt stalks_core stalks_tests dump_master_meta dump_child_nimbers query_position explain_move query_movetype debug_spec_order save_spec verify_spec_count collect_alpha_genetics dump_collections_roster quick_reduction_counts verify_left_side region_frequency unregistered_left_sides yellow_check find_yellow_candidates)
        target_compile_options(${tgt} PRIVATE /W4 /permissive- /utf-8)
    endforeach()
else()
    foreach(tgt stalks_core stalks_tests dump_master_meta dump_child_nimbers query_position explain_move query_movetype debug_spec_order save_spec verify_spec_count collect_alpha_genetics dump_collections_roster quick_reduction_counts verify_left_side region_frequency unregistered_left_sides yellow_check find_yellow_candidates)
        target_compile_options(${tgt} PRIVATE -Wall -Wextra)
    endforeach()
endif()

enable_testing()
add_test(NAME core COMMAND stalks_tests)
