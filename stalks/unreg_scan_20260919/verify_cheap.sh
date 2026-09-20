#!/bin/bash
set -u
FAIL=0
echo '=== group 0 rep=3ABC|2ABaC ==='
./build/verify_left_side.exe "3ABC|2ABaC" 0 "3ABC|2ACaB" "3ABC|2BAaC" "2ABaC|3,ABC" || FAIL=1
echo '=== group 1 rep=3ABC|3ABCa ==='
./build/verify_left_side.exe "3ABC|3ABCa" 0 "3ABC|3ACBa" "3ABC|3BACa" || FAIL=1
echo '=== group 2 rep=3ABC|2,ABCa ==='
./build/verify_left_side.exe "3ABC|2,ABCa" 0 "3ABC|2,ACBa" "2,ABCa|3,ABC" || FAIL=1
echo '=== group 3 rep=3ABC|2ABCa ==='
./build/verify_left_side.exe "3ABC|2ABCa" 0 "3ABC|2ACBa" "3ABC|2BACa" "2ABCa|3,ABC" || FAIL=1
echo '=== group 4 rep=3ABC|a,2ABC ==='
./build/verify_left_side.exe "3ABC|a,2ABC" 0 "3ABC|a,2ACB" "3,ABC|a,2ABC" || FAIL=1
echo '=== group 5 rep=3ABC|2,a,ABC ==='
./build/verify_left_side.exe "3ABC|2,a,ABC" 0 "3,ABC|2,a,ABC" || FAIL=1
echo '=== group 6 rep=3ABC|2a,ABC ==='
./build/verify_left_side.exe "3ABC|2a,ABC" 0 "3,ABC|2a,ABC" || FAIL=1
echo '=== group 7 rep=2,2227a8 ==='
./build/verify_left_side.exe "2,2227a8" 0 "AB|2,2A7a8B" || FAIL=1
echo '=== group 8 rep=4ABC|ABCa ==='
./build/verify_left_side.exe "4ABC|ABCa" 0 "4ABC|ACBa" || FAIL=1
echo '=== group 9 rep=3A|ABCD|BCDa ==='
./build/verify_left_side.exe "3A|ABCD|BCDa" 0 "3A|ABCD|BDCa" "3A|BCDa|A,BCD" || FAIL=1
echo '=== group 10 rep=4A|A,22a ==='
./build/verify_left_side.exe "4A|A,22a" 0 "2AB|AB,22a" || FAIL=1
echo '=== group 11 rep=2ABC|2ABCa ==='
./build/verify_left_side.exe "2ABC|2ABCa" 0 "2ABC|2ACBa" "2ABC|2BACa" "2ABCa|2,ABC" || FAIL=1
echo '=== group 12 rep=4A|A,23a ==='
./build/verify_left_side.exe "4A|A,23a" 0 "4A|A,27a8" "2AB|AB,23a" "2AB|AB,27a8" || FAIL=1
echo '=== group 13 rep=2ABa|4,AB ==='
./build/verify_left_side.exe "2ABa|4,AB" 0 "3A|ABC|2BCa" || FAIL=1
echo '=== group 14 rep=2A3B|2ABa ==='
./build/verify_left_side.exe "2A3B|2ABa" 0 "2ABa|3,2AB" "2ABa|2,3,AB" || FAIL=1
echo '=== group 15 rep=22AB|2ABa ==='
./build/verify_left_side.exe "22AB|2ABa" 0 "23AB|2ABa" "23AB|2BAa" "2ABa|27AB8" || FAIL=1
echo '=== group 16 rep=4A|2,A,2a ==='
./build/verify_left_side.exe "4A|2,A,2a" 0 "4A|2,A,3a" || FAIL=1
echo '=== group 17 rep=ABa|AB,223 ==='
./build/verify_left_side.exe "ABa|AB,223" 0 "ABa|AB,2728" || FAIL=1
echo '=== group 18 rep=3AB|CDa|ABCD ==='
./build/verify_left_side.exe "3AB|CDa|ABCD" 0 "3AB|CDa|AB,CD" || FAIL=1
echo '=== group 19 rep=ABCa|3A3BC ==='
./build/verify_left_side.exe "ABCa|3A3BC" 0 "ABCa|3B3AC" || FAIL=1
echo '=== group 20 rep=2,a,26 ==='
./build/verify_left_side.exe "2,a,26" 0 "2,a,224" || FAIL=1
echo '=== group 21 rep=ABCa|22ABC ==='
./build/verify_left_side.exe "ABCa|22ABC" 0 "ABCa|22ACB" "22ABC|a,ABC" || FAIL=1
echo '=== group 22 rep=ABCa|23ABC ==='
./build/verify_left_side.exe "ABCa|23ABC" 0 "ABCa|23ACB" "ABCa|23BAC" "23ABC|a,ABC" || FAIL=1
echo '=== group 23 rep=ABCa|27ABC8 ==='
./build/verify_left_side.exe "ABCa|27ABC8" 0 "ABCa|27ACB8" "27ABC8|a,ABC" || FAIL=1
echo '=== group 24 rep=4AB|3a,AB ==='
./build/verify_left_side.exe "4AB|3a,AB" 0 "4,AB|3a,AB" "3AB|3Ca|ABC" "3A|ABC|3a,BC" || FAIL=1
echo '=== group 25 rep=3A|ABCD|a,BCD ==='
./build/verify_left_side.exe "3A|ABCD|a,BCD" 0 "3A|A,BCD|a,BCD" || FAIL=1
echo '=== group 26 rep=4AB|a,3AB ==='
./build/verify_left_side.exe "4AB|a,3AB" 0 "4,AB|a,3AB" || FAIL=1
echo '=== group 27 rep=4AB|3ABa ==='
./build/verify_left_side.exe "4AB|3ABa" 0 "3ABa|4,AB" || FAIL=1
echo '=== group 28 rep=4AB|3,ABa ==='
./build/verify_left_side.exe "4AB|3,ABa" 0 "3,ABa|4,AB" "4AB|3,a,AB" "4,AB|3,a,AB" || FAIL=1
echo '=== group 29 rep=4A|ABC|BCa ==='
./build/verify_left_side.exe "4A|ABC|BCa" 0 "Aa|4BC|ABC" "2AB|CDa|ABCD" "2AB|CDa|AB,CD" || FAIL=1
echo '=== group 30 rep=2AB|2A3Ba ==='
./build/verify_left_side.exe "2AB|2A3Ba" 0 "2AB|3,2ABa" || FAIL=1
echo '=== group 31 rep=AB|2ACD|BCDa ==='
./build/verify_left_side.exe "AB|2ACD|BCDa" 0 "AB|2ACD|BDCa" || FAIL=1
echo '=== group 32 rep=4A|2,3Aa ==='
./build/verify_left_side.exe "4A|2,3Aa" 0 "4A|2,7A8a" || FAIL=1
echo '=== group 33 rep=2,ABa|4,AB ==='
./build/verify_left_side.exe "2,ABa|4,AB" 0 "3A|ABC|2,BCa" || FAIL=1
echo '=== group 34 rep=2A3B|2,ABa ==='
./build/verify_left_side.exe "2A3B|2,ABa" 0 "2,ABa|3,2AB" "2,ABa|2,3,AB" || FAIL=1
echo '=== group 35 rep=22AB|2,ABa ==='
./build/verify_left_side.exe "22AB|2,ABa" 0 "23AB|2,ABa" "27AB8|2,ABa" || FAIL=1
echo '=== group 36 rep=AB|2AC|3BaC ==='
./build/verify_left_side.exe "AB|2AC|3BaC" 0 "AB|2AC|3CBa" "AB|2AC|3,BCa" || FAIL=1
echo '=== group 37 rep=AB|5AC|BCa ==='
./build/verify_left_side.exe "AB|5AC|BCa" 0 "AB|ACa|37BC8" || FAIL=1
echo '=== group 38 rep=4A|4,Aa ==='
./build/verify_left_side.exe "4A|4,Aa" 0 "3A|4B|ABa" "3A|2BC|BC,Aa" || FAIL=1
echo '=== group 39 rep=ABCa|2,3ABC ==='
./build/verify_left_side.exe "ABCa|2,3ABC" 0 "ABCa|2,3ACB" "2,3ABC|a,ABC" || FAIL=1
echo '=== group 40 rep=4,AB|a,2AB ==='
./build/verify_left_side.exe "4,AB|a,2AB" 0 "3A|ABC|a,2BC" || FAIL=1
echo '=== group 41 rep=2AB|3A7a8B ==='
./build/verify_left_side.exe "2AB|3A7a8B" 0 "2AB|3,7AB8a" || FAIL=1
echo '=== group 42 rep=2ABC|a,3ABC ==='
./build/verify_left_side.exe "2ABC|a,3ABC" 0 "2ABC|a,3ACB" || FAIL=1
echo '=== group 43 rep=2AB|a,5AB ==='
./build/verify_left_side.exe "2AB|a,5AB" 0 "2AB|a,37AB8" || FAIL=1
echo '=== group 44 rep=2ABC|3,a,ABC ==='
./build/verify_left_side.exe "2ABC|3,a,ABC" 0 "2,ABC|3,a,ABC" || FAIL=1
echo '=== group 45 rep=3AB|ACD|BCDa ==='
./build/verify_left_side.exe "3AB|ACD|BCDa" 0 "3AB|ACD|a,BCD" "ABC|ADa|3,BCD" || FAIL=1
echo '=== group 46 rep=2A3B|a,2AB ==='
./build/verify_left_side.exe "2A3B|a,2AB" 0 "3,2AB|a,2AB" "a,2AB|2,3,AB" || FAIL=1
echo '=== group 47 rep=4A|a,23A ==='
./build/verify_left_side.exe "4A|a,23A" 0 "4A|a,27A8" || FAIL=1
echo '=== group 48 rep=22AB|a,2AB ==='
./build/verify_left_side.exe "22AB|a,2AB" 0 "23AB|a,2AB" "27AB8|a,2AB" || FAIL=1
echo '=== group 49 rep=AB|ACDE|a,BCDE ==='
./build/verify_left_side.exe "AB|ACDE|a,BCDE" 0 "ABC|ADE|a,BCDE" || FAIL=1
echo '=== group 50 rep=2AB|ACD|BCDa ==='
./build/verify_left_side.exe "2AB|ACD|BCDa" 0 "2AB|ACD|a,BCD" || FAIL=1
echo '=== group 51 rep=3ABC|3ABaC ==='
./build/verify_left_side.exe "3ABC|3ABaC" 0 "3ABC|3ACaB" "3ABC|3BAaC" || FAIL=1
echo '=== group 52 rep=2AB|2,3AaB ==='
./build/verify_left_side.exe "2AB|2,3AaB" 0 "2AB|2,3ABa" || FAIL=1
echo '=== group 53 rep=AB|ACD|2,BCDa ==='
./build/verify_left_side.exe "AB|ACD|2,BCDa" 0 "AB|ACD|2,CBDa" || FAIL=1
echo '=== group 54 rep=AB|AC|1BaC ==='
./build/verify_left_side.exe "AB|AC|1BaC" 0 "AB|AC|37BaC8" || FAIL=1
echo '=== group 55 rep=2ABC|2ABaC ==='
./build/verify_left_side.exe "2ABC|2ABaC" 0 "2ABC|2ACaB" "2ABC|2BAaC" "2ABaC|2,ABC" || FAIL=1
echo '=== group 56 rep=2AB|23aAB ==='
./build/verify_left_side.exe "2AB|23aAB" 0 "2AB|23AaB" "2AB|2A3aB" "2AB|3,2AaB" || FAIL=1
echo '=== group 57 rep=ABCa|2A2BC ==='
./build/verify_left_side.exe "ABCa|2A2BC" 0 "ABCa|2B2AC" "2A2BC|a,ABC" || FAIL=1
echo '=== group 58 rep=2A2B|3AaB ==='
./build/verify_left_side.exe "2A2B|3AaB" 0 "2A2B|3ABa" "2A2B|3,ABa" "2A2B|a,3AB" "2A2B|3,a,AB" || FAIL=1
echo '=== group 59 rep=2ABC|a,2ABC ==='
./build/verify_left_side.exe "2ABC|a,2ABC" 0 "2ABC|a,2ACB" "2,ABC|a,2ABC" || FAIL=1
echo '=== group 60 rep=2ABC|2,ABCa ==='
./build/verify_left_side.exe "2ABC|2,ABCa" 0 "2ABC|2,ACBa" "2,ABC|2,ABCa" || FAIL=1
echo '=== group 61 rep=2AaB|4,AB ==='
./build/verify_left_side.exe "2AaB|4,AB" 0 "3A|ABC|2BaC" || FAIL=1
echo '=== group 62 rep=2AB|5ABa ==='
./build/verify_left_side.exe "2AB|5ABa" 0 "AB|ACD|3,BCDa" "AB|ACD|3,CBDa" || FAIL=1
echo '=== group 63 rep=2AB|2,a,3AB ==='
./build/verify_left_side.exe "2AB|2,a,3AB" 0 "2ABC|2,a,ABC" "2,ABC|2,a,ABC" || FAIL=1
echo '=== group 64 rep=ABCa|2A3BC ==='
./build/verify_left_side.exe "ABCa|2A3BC" 0 "ABCa|2A3CB" "ABCa|2B3AC" "2A3BC|a,ABC" || FAIL=1
echo '=== group 65 rep=4,AB|2,a,AB ==='
./build/verify_left_side.exe "4,AB|2,a,AB" 0 "3A|ABC|2,a,BC" || FAIL=1
echo '=== group 66 rep=2ABC|3ABaC ==='
./build/verify_left_side.exe "2ABC|3ABaC" 0 "2ABC|3ACaB" "2ABC|3BAaC" "2ABC|3,ABCa" "2ABC|3,ACBa" || FAIL=1
echo '=== group 67 rep=2AaB|2,3AB ==='
./build/verify_left_side.exe "2AaB|2,3AB" 0 "2,3AB|2,a,AB" || FAIL=1
echo '=== group 68 rep=2A3B|2AaB ==='
./build/verify_left_side.exe "2A3B|2AaB" 0 "2AaB|3,2AB" "2A3B|2,a,AB" "2AaB|2,3,AB" "3,2AB|2,a,AB" "2,3,AB|2,a,AB" || FAIL=1
echo '=== group 69 rep=2AB|5AaB ==='
./build/verify_left_side.exe "2AB|5AaB" 0 "2AB|37AaB8" || FAIL=1
echo '=== group 70 rep=4A|a,22A ==='
./build/verify_left_side.exe "4A|a,22A" 0 "2AB|1,a,AB" "2AB|a,23,AB" || FAIL=1
echo '=== group 71 rep=22AB|2AaB ==='
./build/verify_left_side.exe "22AB|2AaB" 0 "23AB|2AaB" "2AaB|27AB8" "22AB|2,a,AB" "23AB|2,a,AB" "27AB8|2,a,AB" "AB|3AC|2,a,BC" "ABC|ABD|2,a,CD" || FAIL=1
echo '=== group 72 rep=3ABaC|2,ABC ==='
./build/verify_left_side.exe "3ABaC|2,ABC" 0 "2,ABC|3,ABCa" || FAIL=1
echo '=== group 73 rep=ABCa|2,2,ABC ==='
./build/verify_left_side.exe "ABCa|2,2,ABC" 0 "a,ABC|2,2,ABC" || FAIL=1
echo '=== group 74 rep=ABa|22A2B ==='
./build/verify_left_side.exe "ABa|22A2B" 0 "ABa|2,2A2B" || FAIL=1
echo '=== group 75 rep=ABCa|2,2ABC ==='
./build/verify_left_side.exe "ABCa|2,2ABC" 0 "ABCa|2,2ACB" "2,2ABC|a,ABC" || FAIL=1
echo '=== group 76 rep=3AB|AB,23a ==='
./build/verify_left_side.exe "3AB|AB,23a" 0 "3AB|AB,27a8" || FAIL=1
echo '=== group 77 rep=3AB|1a,AB ==='
./build/verify_left_side.exe "3AB|1a,AB" 0 "3AB|5a,AB" "3AB|AB,37a8" || FAIL=1
echo '=== group 78 rep=ABa|3,5AB ==='
./build/verify_left_side.exe "ABa|3,5AB" 0 "ABa|3,37AB8" || FAIL=1
echo '=== group 79 rep=Aa|1,1A ==='
./build/verify_left_side.exe "Aa|1,1A" 0 "Aa|1A,23" || FAIL=1
echo '=== group 80 rep=ABa|35AB ==='
./build/verify_left_side.exe "ABa|35AB" 0 "ABa|3738AB" || FAIL=1
echo '=== group 81 rep=ABa|12,AB ==='
./build/verify_left_side.exe "ABa|12,AB" 0 "ABa|25,AB" "ABa|AB,2738" || FAIL=1
echo '=== group 82 rep=ABCa|3,3ABC ==='
./build/verify_left_side.exe "ABCa|3,3ABC" 0 "ABCa|3,3ACB" || FAIL=1
echo '=== group 83 rep=ABCa|33ABC ==='
./build/verify_left_side.exe "ABCa|33ABC" 0 "ABCa|33ACB" || FAIL=1
echo '=== group 84 rep=5ABC|ABCa ==='
./build/verify_left_side.exe "5ABC|ABCa" 0 "5ABC|ACBa" "5ABC|a,ABC" "ABCa|37ABC8" "ABCa|37ACB8" "37ABC8|a,ABC" || FAIL=1
echo '=== group 85 rep=1ABC|ABCa ==='
./build/verify_left_side.exe "1ABC|ABCa" 0 "1ABC|ACBa" "1ABC|a,ABC" || FAIL=1
echo '=== group 86 rep=3,2AB|3a,AB ==='
./build/verify_left_side.exe "3,2AB|3a,AB" 0 "3a,AB|2,3,AB" || FAIL=1
echo '=== group 87 rep=3AaB|27AB8 ==='
./build/verify_left_side.exe "3AaB|27AB8" 0 "3ABa|27AB8" "27AB8|3,ABa" "27AB8|a,3AB" "27AB8|3,a,AB" || FAIL=1
echo '=== group 88 rep=22AB|3a,AB ==='
./build/verify_left_side.exe "22AB|3a,AB" 0 "23AB|3a,AB" "27AB8|3a,AB" || FAIL=1
echo '=== group 89 rep=22AB|3AaB ==='
./build/verify_left_side.exe "22AB|3AaB" 0 "22AB|3ABa" "22AB|3,ABa" "22AB|a,3AB" "22AB|3,a,AB" || FAIL=1
echo '=== group 90 rep=ABCa|23,ABC ==='
./build/verify_left_side.exe "ABCa|23,ABC" 0 "a,ABC|23,ABC" || FAIL=1
echo '=== group 91 rep=ABCa|1,ABC ==='
./build/verify_left_side.exe "ABCa|1,ABC" 0 "1,ABC|a,ABC" || FAIL=1
echo '=== group 92 rep=1AB|3AaB ==='
./build/verify_left_side.exe "1AB|3AaB" 0 "1AB|3ABa" "1AB|3,ABa" "1AB|a,3AB" "1AB|3,a,AB" || FAIL=1
echo '=== group 93 rep=5AB|3AaB ==='
./build/verify_left_side.exe "5AB|3AaB" 0 "5AB|3ABa" "5AB|3,ABa" "3AaB|37AB8" "3ABa|37AB8" "37AB8|3,ABa" || FAIL=1
echo '=== group 94 rep=5AB|3a,AB ==='
./build/verify_left_side.exe "5AB|3a,AB" 0 "37AB8|3a,AB" || FAIL=1
echo '=== group 95 rep=3A|12,Aa ==='
./build/verify_left_side.exe "3A|12,Aa" 0 "3A|25,Aa" "3A|Aa,2738" || FAIL=1
echo '=== group 96 rep=3AaB|2,2AB ==='
./build/verify_left_side.exe "3AaB|2,2AB" 0 "3ABa|2,2AB" "2,2AB|3,ABa" "2,2AB|a,3AB" "2,2AB|3,a,AB" || FAIL=1
echo '=== group 97 rep=ABCa|2,3,ABC ==='
./build/verify_left_side.exe "ABCa|2,3,ABC" 0 "a,ABC|2,3,ABC" || FAIL=1
echo '=== group 98 rep=4,25a ==='
./build/verify_left_side.exe "4,25a" 0 "4,233a" || FAIL=1
echo '=== group 99 rep=3A|2a,5A ==='
./build/verify_left_side.exe "3A|2a,5A" 0 "3A|2a,37A8" || FAIL=1
echo '=== group 100 rep=3ABC|3,ABCa ==='
./build/verify_left_side.exe "3ABC|3,ABCa" 0 "3ABC|3,ACBa" || FAIL=1
echo '=== group 101 rep=2A2B|2AaB ==='
./build/verify_left_side.exe "2A2B|2AaB" 0 "2A2B|2,a,AB" "2AaB|2,2,AB" "2,2,AB|2,a,AB" || FAIL=1
echo '=== group 102 rep=2Aa|232A ==='
./build/verify_left_side.exe "2Aa|232A" 0 "2A2B|2a,AB" "2Aa|2,2,2A" "2a,AB|2,2,AB" || FAIL=1
echo '=== group 103 rep=2A2B|2,ABa ==='
./build/verify_left_side.exe "2A2B|2,ABa" 0 "2,ABa|2,2,AB" || FAIL=1
echo '=== group 104 rep=2A2B|2ABa ==='
./build/verify_left_side.exe "2A2B|2ABa" 0 "2ABa|2,2,AB" || FAIL=1
echo '=== group 105 rep=3AaB|2,2,AB ==='
./build/verify_left_side.exe "3AaB|2,2,AB" 0 "3ABa|2,2,AB" "3,ABa|2,2,AB" "a,3AB|2,2,AB" "2,2,AB|3,a,AB" || FAIL=1
echo '=== group 106 rep=2A2B|a,2AB ==='
./build/verify_left_side.exe "2A2B|a,2AB" 0 "a,2AB|2,2,AB" || FAIL=1
echo '=== group 107 rep=2A2B|7AB8a ==='
./build/verify_left_side.exe "2A2B|7AB8a" 0 "7AB8a|2,2,AB" || FAIL=1
echo '=== group 108 rep=AB|AC|2BD|CDa ==='
./build/verify_left_side.exe "AB|AC|2BD|CDa" 0 "AB|ACD|BCE|DEa" || FAIL=1
echo '=== group 109 rep=2,2AB|2,ABa ==='
./build/verify_left_side.exe "2,2AB|2,ABa" 0 "AB|2AC|2BaC" || FAIL=1
echo '=== group 110 rep=6A|2Aa ==='
./build/verify_left_side.exe "6A|2Aa" 0 "2Aa|2,23A" "2Aa|2728A" || FAIL=1
echo '=== group 111 rep=1,2,2,2,a ==='
./build/verify_left_side.exe "1,2,2,2,a" 0 "2,2,2,5,a" || FAIL=1
echo '=== group 112 rep=AB|2AC|2BCa ==='
./build/verify_left_side.exe "AB|2AC|2BCa" 0 "AB|AC|BD|7CD8a" "AB|CD|ACE|BDEa" || FAIL=1
echo '=== group 113 rep=AB|ACa|4,BC ==='
./build/verify_left_side.exe "AB|ACa|4,BC" 0 "3A|BC|ABD|CDa" || FAIL=1
echo '=== group 114 rep=24A|2Aa ==='
./build/verify_left_side.exe "24A|2Aa" 0 "2Aa|47A8" "2Aa|A,24" "4A|AB|2Ba" "AB|2Ca|2ACB" || FAIL=1
echo '=== group 115 rep=2AaB|2,2AB ==='
./build/verify_left_side.exe "2AaB|2,2AB" 0 "2,2AB|2,a,AB" "AB|2AC|2,a,BC" || FAIL=1
echo '=== group 116 rep=3,2227a8 ==='
./build/verify_left_side.exe "3,2227a8" 0 "AB|3,2A7a8B" || FAIL=1
echo '=== group 117 rep=3A|22A2a ==='
./build/verify_left_side.exe "3A|22A2a" 0 "3A|2,2A2a" || FAIL=1
echo '=== group 118 rep=3A|222Aa ==='
./build/verify_left_side.exe "3A|222Aa" 0 "3A|2,22Aa" || FAIL=1
echo '=== group 119 rep=3,2222a ==='
./build/verify_left_side.exe "3,2222a" 0 "AB|3,2A2Ba" || FAIL=1
echo '=== group 120 rep=227382a ==='
./build/verify_left_side.exe "227382a" 0 "AB|2A738Ba" || FAIL=1
echo '=== group 121 rep=122a2 ==='
./build/verify_left_side.exe "122a2" 0 "AB|1A2aB" || FAIL=1
echo '=== group 122 rep=2252a ==='
./build/verify_left_side.exe "2252a" 0 "AB|2A5Ba" || FAIL=1
echo '=== group 123 rep=3,a,26 ==='
./build/verify_left_side.exe "3,a,26" 0 "3,a,224" || FAIL=1
echo '=== group 124 rep=222738a ==='
./build/verify_left_side.exe "222738a" 0 "AB|2A738aB" || FAIL=1
echo '=== group 125 rep=2225a ==='
./build/verify_left_side.exe "2225a" 0 "AB|2A5aB" || FAIL=1
echo '=== group 126 rep=1222a ==='
./build/verify_left_side.exe "1222a" 0 "AB|1A2Ba" || FAIL=1
echo '=== group 127 rep=3a,2222 ==='
./build/verify_left_side.exe "3a,2222" 0 "AB|3a,2A2B" || FAIL=1
echo '=== group 128 rep=ABa|3A5B ==='
./build/verify_left_side.exe "ABa|3A5B" 0 "ABa|37A3B8" || FAIL=1
echo '=== group 129 rep=ABCa|3,2ABC ==='
./build/verify_left_side.exe "ABCa|3,2ABC" 0 "ABCa|3,2ACB" "3,2ABC|a,ABC" || FAIL=1
echo DONE FAIL=$FAIL
