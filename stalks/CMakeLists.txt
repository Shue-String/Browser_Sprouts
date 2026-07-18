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
    src/analyze.cpp
)
target_include_directories(stalks_core PUBLIC src)

add_executable(stalks_tests tests/test_main.cpp)
target_link_libraries(stalks_tests PRIVATE stalks_core)

add_executable(dump_master_meta tools/dump_master_meta.cpp)
target_link_libraries(dump_master_meta PRIVATE stalks_core)

add_executable(dump_child_nimbers tools/dump_child_nimbers.cpp)
target_link_libraries(dump_child_nimbers PRIVATE stalks_core)

if(MSVC)
    foreach(tgt stalks_core stalks_tests dump_master_meta dump_child_nimbers)
        target_compile_options(${tgt} PRIVATE /W4 /permissive- /utf-8)
    endforeach()
else()
    foreach(tgt stalks_core stalks_tests dump_master_meta dump_child_nimbers)
        target_compile_options(${tgt} PRIVATE -Wall -Wextra)
    endforeach()
endif()

enable_testing()
add_test(NAME core COMMAND stalks_tests)
