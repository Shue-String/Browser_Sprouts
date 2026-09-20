#!/bin/bash
set -u
echo '=== S_125 rep=4A|2,3Aa ==='
./build/verify_left_side.exe "4A|2,3Aa" 0 "AB|AC|2BD|2,CDa"
echo '=== S_131 rep=4A|4,Aa ==='
./build/verify_left_side.exe "4A|4,Aa" 0 "AB|AC|DE|2BD|CEa"
echo '=== S_140 rep=4A|a,23A ==='
./build/verify_left_side.exe "4A|a,23A" 0 "AB|AC|2BD|a,2CD"
echo '=== S_164 rep=22AB|2AaB ==='
./build/verify_left_side.exe "22AB|2AaB" 0 "AB|AC|BD|CE|2,a,DE"
echo '=== S_172 rep=Aa|1,1A ==='
./build/verify_left_side.exe "Aa|1,1A" 0 "Aa|2BC|1,ABC"
echo '=== S_174 rep=ABa|12,AB ==='
./build/verify_left_side.exe "ABa|12,AB" 0 "2AB|CDa|CD,2AB"
echo '=== S_188 rep=3A|12,Aa ==='
./build/verify_left_side.exe "3A|12,Aa" 0 "3A|2BC|Aa,2BC"
echo '=== S_192 rep=3A|2a,5A ==='
./build/verify_left_side.exe "3A|2a,5A" 0 "3A|2BC|2a,ABC" "AB|2AC|2a,3BC"
echo '=== S_203 rep=1,2,2,2,a ==='
./build/verify_left_side.exe "1,2,2,2,a" 0 "2AB|2,2,2,a,AB"
