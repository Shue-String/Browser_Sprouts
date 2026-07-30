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

add_executable(collect_genetics tools/collect_genetics.cpp)
target_link_libraries(collect_genetics PRIVATE stalks_core)

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

add_executable(collect_alpha_genetics tools/collect_alpha_genetics.cpp)
target_link_libraries(collect_alpha_genetics PRIVATE stalks_core)

if(MSVC)
    foreach(tgt stalks_core stalks_tests dump_master_meta dump_child_nimbers collect_genetics query_position explain_move query_movetype debug_spec_order save_spec verify_spec_count collect_alpha_genetics)
        target_compile_options(${tgt} PRIVATE /W4 /permissive- /utf-8)
    endforeach()
else()
    foreach(tgt stalks_core stalks_tests dump_master_meta dump_child_nimbers collect_genetics query_position explain_move query_movetype debug_spec_order save_spec verify_spec_count collect_alpha_genetics)
        target_compile_options(${tgt} PRIVATE -Wall -Wextra)
    endforeach()
endif()

enable_testing()
add_test(NAME core COMMAND stalks_tests)
