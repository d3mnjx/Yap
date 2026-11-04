# Yap responsiveness: A = main, B = main-again

2026-11-04 11:37 UTC. Wall time 28 min 32 s. 5 repetitions, every journey (--full).

- A (main): /home/agent/yap-perf/harness, 7f149be4 Docs: the plan for the emoji warm-up, design only, nothing built; the server answered 2873 ms after its start (the seed loads into memory first).
- B (main-again): /home/agent/yap-perf/harness, 7f149be4 Docs: the plan for the emoji warm-up, design only, nothing built; the server answered 2867 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: cold-open, warm-open, resume, send, switch-room, older, picker-emoji, picker-gif, phone-cold-open, phone-older.

| journey | metric | A: main | B: main-again | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 1192 | 1191 | -1.5 | -0.1% |
| cold-open | scripts ms | 13463 | 13519 | +55.9 | +0.4% |
| cold-open | bootstrap ms | 14487 | 14544 | +57.6 | +0.4% |
| cold-open | paint ms | 18054 | 18032 | -22.7 | -0.1% |
| cold-open | socket ms | 16751 | 16738 | -13.6 | -0.1% |
| cold-open | rows ms | 18054 | 18032 | -22.7 | -0.1% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 815 | +0 | +0.0% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1006 | 1006 | +0.3 | +0.0% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.5 | 2.3 | -0.2 | -8.0% |
| warm-open | scripts ms | 24.6 | 28.2 | +3.6 | +14.6% |
| warm-open | bootstrap ms | 3004 | 3017 | +12.5 | +0.4% |
| warm-open | paint ms | 65.9 | 59.1 | -6.8 | -10.3% |
| warm-open | socket ms | 1845 | 1850 | +4.3 | +0.2% |
| warm-open | rows ms | 3001 | 3014 | +12.3 | +0.4% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 3 | 3 | +0 | +0.0% |
| warm-open | wire KB | 35.7 | 35.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |
| resume | return to rows ms | 2979 | 2976 | -3.6 | -0.1% |
| send | own row ms | 1.3 | 1.2 | -0.1 | -7.7% |
| send | confirmed ms | 918 | 918 | +0.3 | +0.0% |
| switch-room | to pets (200) ms | 1268 | 1265 | -3.6 | -0.3% |
| switch-room | to lobby (20000) ms | 1164 | 1162 | -1.8 | -0.2% |
| older | page landed ms | 1149 | 1146 | -2.4 | -0.2% |
| older | long tasks | 0 | 0 | +0 | — |
| older | long task ms | 0 | 0 | +0 | — |
| picker-emoji | first: grid ms | 24 | 24.2 | +0.2 | +0.8% |
| picker-emoji | first: images ms | 8648 | 8649 | +1.1 | +0.0% |
| picker-emoji | first: requests in 2 s | 408 | 408 | +0 | +0.0% |
| picker-emoji | again: grid ms | 20.2 | 20.6 | +0.4 | +2.0% |
| picker-emoji | again: images ms | 516 | 497 | -19.1 | -3.7% |
| picker-emoji | again: requests in 2 s | 434 | 434 | +0 | +0.0% |
| picker-gif | first: grid ms | 927 | 928 | +0.8 | +0.1% |
| picker-gif | first: images ms | 2914 | 2914 | +0.1 | +0.0% |
| picker-gif | again: grid ms | 928 | 927 | -0.6 | -0.1% |
| picker-gif | again: images ms | 948 | 948 | +0.3 | +0.0% |
| phone-cold-open | html ms | 1189 | 1189 | +0.2 | +0.0% |
| phone-cold-open | scripts ms | 13507 | 13555 | +48.5 | +0.4% |
| phone-cold-open | bootstrap ms | 14531 | 14578 | +47.3 | +0.3% |
| phone-cold-open | paint ms | 18169 | 18213 | +43.4 | +0.2% |
| phone-cold-open | socket ms | 16822 | 16886 | +64.2 | +0.4% |
| phone-cold-open | rows ms | 18169 | 18213 | +43.5 | +0.2% |
| phone-cold-open | requests | 60 | 60 | +0 | +0.0% |
| phone-cold-open | cached | 0 | 0 | +0 | — |
| phone-cold-open | KB | 815 | 815 | +0 | +0.0% |
| phone-cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| phone-cold-open | wire KB | 1007 | 1007 | +0 | +0.0% |
| phone-cold-open | long tasks | 2 | 2 | +0 | +0.0% |
| phone-cold-open | long task ms | 208 | 203 | -5 | -2.4% |
| phone-cold-open | heap MB | 2 | 2 | +0 | +0.0% |
| phone-older | page landed ms | 1235 | 1233 | -1.3 | -0.1% |
| phone-older | long tasks | 4 | 5 | +1 | +25.0% |
| phone-older | long task ms | 377 | 421 | +44 | +11.7% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 1190 | 1197 | 1190 | 1208 | 5/5 |
| cold-open | scripts ms | 13418 | 13715 | 13454 | 13640 | 5/5 |
| cold-open | bootstrap ms | 14440 | 14739 | 14478 | 14663 | 5/5 |
| cold-open | paint ms | 17977 | 18268 | 17986 | 18155 | 5/5 |
| cold-open | socket ms | 16675 | 16932 | 16675 | 16872 | 5/5 |
| cold-open | rows ms | 17977 | 18268 | 17986 | 18155 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 815 | 815 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1005 | 1006 | 1005 | 1006 | 5/5 |
| cold-open | long tasks | 0 | 1 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 82 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.2 | 7.7 | 2.1 | 2.8 | 5/5 |
| warm-open | scripts ms | 21.9 | 59 | 21.7 | 59.3 | 5/5 |
| warm-open | bootstrap ms | 3001 | 3035 | 2999 | 3043 | 5/5 |
| warm-open | paint ms | 56.8 | 103 | 57.7 | 88.2 | 5/5 |
| warm-open | socket ms | 1845 | 1878 | 1844 | 1879 | 5/5 |
| warm-open | rows ms | 2998 | 3032 | 2996 | 3040 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 3 | 3 | 3 | 3 | 5/5 |
| warm-open | wire KB | 35.7 | 35.7 | 35.7 | 35.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 2 | 2.1 | 5/5 |
| resume | return to rows ms | 2972 | 2983 | 2974 | 2980 | 5/5 |
| send | own row ms | 0.9 | 4.6 | 1 | 13.2 | 50/50 |
| send | confirmed ms | 915 | 934 | 916 | 931 | 50/50 |
| switch-room | to pets (200) ms | 1265 | 1280 | 1262 | 1267 | 5/5 |
| switch-room | to lobby (20000) ms | 1159 | 1166 | 1160 | 1165 | 5/5 |
| older | page landed ms | 1117 | 1159 | 1115 | 1158 | 15/15 |
| older | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| older | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| picker-emoji | first: grid ms | 22.9 | 26 | 23.1 | 25.6 | 5/5 |
| picker-emoji | first: images ms | 8632 | 8649 | 8648 | 8665 | 5/5 |
| picker-emoji | first: requests in 2 s | 408 | 408 | 408 | 408 | 5/5 |
| picker-emoji | again: grid ms | 20 | 20.6 | 18.1 | 21.1 | 5/5 |
| picker-emoji | again: images ms | 491 | 612 | 493 | 518 | 5/5 |
| picker-emoji | again: requests in 2 s | 434 | 434 | 434 | 434 | 5/5 |
| picker-gif | first: grid ms | 925 | 933 | 927 | 933 | 5/5 |
| picker-gif | first: images ms | 2914 | 2931 | 2912 | 2932 | 5/5 |
| picker-gif | again: grid ms | 926 | 928 | 926 | 933 | 5/5 |
| picker-gif | again: images ms | 946 | 948 | 947 | 965 | 5/5 |
| phone-cold-open | html ms | 1188 | 1190 | 1189 | 1196 | 5/5 |
| phone-cold-open | scripts ms | 13484 | 13597 | 13444 | 13764 | 5/5 |
| phone-cold-open | bootstrap ms | 14505 | 14621 | 14467 | 14788 | 5/5 |
| phone-cold-open | paint ms | 18113 | 18266 | 18108 | 18383 | 5/5 |
| phone-cold-open | socket ms | 16730 | 16832 | 16724 | 16989 | 5/5 |
| phone-cold-open | rows ms | 18113 | 18266 | 18108 | 18383 | 5/5 |
| phone-cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| phone-cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| phone-cold-open | KB | 815 | 815 | 815 | 815 | 5/5 |
| phone-cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| phone-cold-open | wire KB | 1006 | 1007 | 1005 | 1007 | 5/5 |
| phone-cold-open | long tasks | 1 | 3 | 1 | 3 | 5/5 |
| phone-cold-open | long task ms | 147 | 355 | 152 | 340 | 5/5 |
| phone-cold-open | heap MB | 2 | 2 | 2 | 2 | 5/5 |
| phone-older | page landed ms | 1204 | 1287 | 1207 | 1284 | 15/15 |
| phone-older | long tasks | 3 | 4 | 4 | 5 | 5/5 |
| phone-older | long task ms | 335 | 435 | 370 | 430 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: cold-open, warm-open, resume, send, switch-room, older, picker-emoji, picker-gif, phone-cold-open, phone-older.

| journey | metric | A: main | B: main-again | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 81.2 | 82.3 | +1.1 | +1.4% |
| cold-open | scripts ms | 986 | 972 | -13.6 | -1.4% |
| cold-open | bootstrap ms | 1066 | 1053 | -12.6 | -1.2% |
| cold-open | paint ms | 1352 | 1342 | -10.2 | -0.8% |
| cold-open | socket ms | 1217 | 1203 | -14.4 | -1.2% |
| cold-open | rows ms | 1352 | 1342 | -10.2 | -0.8% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 815 | +0 | +0.0% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1007 | 1007 | -0.2 | -0.0% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.1 | 2 | -0.1 | -4.8% |
| warm-open | scripts ms | 23.7 | 25.5 | +1.8 | +7.6% |
| warm-open | bootstrap ms | 288 | 289 | +1.2 | +0.4% |
| warm-open | paint ms | 53.9 | 53.9 | +0 | +0.0% |
| warm-open | socket ms | 158 | 157 | -0.6 | -0.4% |
| warm-open | rows ms | 285 | 286 | +1.1 | +0.4% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 2 | 2 | +0 | +0.0% |
| warm-open | wire KB | 28.7 | 28.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |
| resume | return to rows ms | 258 | 258 | +0 | +0.0% |
| send | own row ms | 1.2 | 1.2 | +0 | +0.0% |
| send | confirmed ms | 67.1 | 67.1 | +0 | +0.0% |
| switch-room | to pets (200) ms | 150 | 151 | +1.3 | +0.9% |
| switch-room | to lobby (20000) ms | 135 | 133 | -1.6 | -1.2% |
| older | page landed ms | 220 | 221 | +1.1 | +0.5% |
| older | long tasks | 0 | 0 | +0 | — |
| older | long task ms | 0 | 0 | +0 | — |
| picker-emoji | first: grid ms | 24 | 23.1 | -0.9 | -3.7% |
| picker-emoji | first: images ms | 951 | 935 | -16.6 | -1.7% |
| picker-emoji | first: requests in 2 s | 435 | 435 | +0 | +0.0% |
| picker-emoji | again: grid ms | 20.9 | 20.3 | -0.6 | -2.9% |
| picker-emoji | again: images ms | 499 | 497 | -2.3 | -0.5% |
| picker-emoji | again: requests in 2 s | 434 | 434 | +0 | +0.0% |
| picker-gif | first: grid ms | 71.4 | 72 | +0.6 | +0.8% |
| picker-gif | first: images ms | 231 | 231 | -0.7 | -0.3% |
| picker-gif | again: grid ms | 72.1 | 73.8 | +1.7 | +2.4% |
| picker-gif | again: images ms | 97.8 | 97.8 | +0 | +0.0% |
| phone-cold-open | html ms | 78.1 | 78.4 | +0.3 | +0.4% |
| phone-cold-open | scripts ms | 970 | 979 | +8.6 | +0.9% |
| phone-cold-open | bootstrap ms | 1063 | 1077 | +14 | +1.3% |
| phone-cold-open | paint ms | 1536 | 1542 | +5.8 | +0.4% |
| phone-cold-open | socket ms | 1288 | 1292 | +3.7 | +0.3% |
| phone-cold-open | rows ms | 1536 | 1542 | +5.8 | +0.4% |
| phone-cold-open | requests | 60 | 60 | +0 | +0.0% |
| phone-cold-open | cached | 2 | 2 | +0 | +0.0% |
| phone-cold-open | KB | 731 | 731 | +0 | +0.0% |
| phone-cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| phone-cold-open | wire KB | 1012 | 1012 | +0 | +0.0% |
| phone-cold-open | long tasks | 2 | 2 | +0 | +0.0% |
| phone-cold-open | long task ms | 203 | 219 | +16 | +7.9% |
| phone-cold-open | heap MB | 2 | 2 | +0 | +0.0% |
| phone-older | page landed ms | 298 | 306 | +7.4 | +2.5% |
| phone-older | long tasks | 4 | 3 | -1 | -25.0% |
| phone-older | long task ms | 369 | 325 | -44 | -11.9% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 80.9 | 84.7 | 80.4 | 84.2 | 5/5 |
| cold-open | scripts ms | 887 | 1017 | 924 | 996 | 5/5 |
| cold-open | bootstrap ms | 971 | 1143 | 1044 | 1119 | 5/5 |
| cold-open | paint ms | 1264 | 1427 | 1323 | 1414 | 5/5 |
| cold-open | socket ms | 1121 | 1286 | 1185 | 1267 | 5/5 |
| cold-open | rows ms | 1264 | 1427 | 1323 | 1414 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 1 | 5/5 |
| cold-open | KB | 815 | 815 | 770 | 815 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1006 | 1007 | 1005 | 1007 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 1.8 | 2.5 | 1.9 | 2.7 | 5/5 |
| warm-open | scripts ms | 20.1 | 57.8 | 23.9 | 49.6 | 5/5 |
| warm-open | bootstrap ms | 285 | 332 | 284 | 314 | 5/5 |
| warm-open | paint ms | 50.8 | 92.1 | 50.6 | 83.3 | 5/5 |
| warm-open | socket ms | 154 | 200 | 155 | 182 | 5/5 |
| warm-open | rows ms | 282 | 329 | 281 | 311 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 2 | 2 | 2 | 2 | 5/5 |
| warm-open | wire KB | 28.7 | 28.7 | 28.7 | 28.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.9 | 2.1 | 5/5 |
| resume | return to rows ms | 255 | 263 | 257 | 261 | 5/5 |
| send | own row ms | 0.9 | 7.3 | 1 | 4.9 | 50/50 |
| send | confirmed ms | 64.9 | 76.1 | 65 | 82.3 | 50/50 |
| switch-room | to pets (200) ms | 145 | 153 | 148 | 169 | 5/5 |
| switch-room | to lobby (20000) ms | 132 | 143 | 131 | 135 | 5/5 |
| older | page landed ms | 216 | 227 | 216 | 239 | 15/15 |
| older | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| older | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| picker-emoji | first: grid ms | 22.6 | 24.8 | 21.9 | 25.5 | 5/5 |
| picker-emoji | first: images ms | 846 | 1066 | 882 | 995 | 5/5 |
| picker-emoji | first: requests in 2 s | 435 | 435 | 435 | 435 | 5/5 |
| picker-emoji | again: grid ms | 19.8 | 23.5 | 20.2 | 22.1 | 5/5 |
| picker-emoji | again: images ms | 449 | 511 | 479 | 530 | 5/5 |
| picker-emoji | again: requests in 2 s | 434 | 434 | 434 | 434 | 5/5 |
| picker-gif | first: grid ms | 70.2 | 73.9 | 70.6 | 72.7 | 5/5 |
| picker-gif | first: images ms | 231 | 248 | 230 | 233 | 5/5 |
| picker-gif | again: grid ms | 70.8 | 72.5 | 71.8 | 75.9 | 5/5 |
| picker-gif | again: images ms | 96.7 | 98.5 | 91.7 | 99.1 | 5/5 |
| phone-cold-open | html ms | 77.6 | 80.5 | 77.6 | 78.7 | 5/5 |
| phone-cold-open | scripts ms | 919 | 1067 | 891 | 1049 | 5/5 |
| phone-cold-open | bootstrap ms | 1052 | 1162 | 987 | 1149 | 5/5 |
| phone-cold-open | paint ms | 1500 | 1649 | 1498 | 1623 | 5/5 |
| phone-cold-open | socket ms | 1249 | 1383 | 1247 | 1366 | 5/5 |
| phone-cold-open | rows ms | 1500 | 1649 | 1498 | 1623 | 5/5 |
| phone-cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| phone-cold-open | cached | 2 | 2 | 2 | 2 | 5/5 |
| phone-cold-open | KB | 731 | 731 | 731 | 731 | 5/5 |
| phone-cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| phone-cold-open | wire KB | 1012 | 1012 | 1012 | 1012 | 5/5 |
| phone-cold-open | long tasks | 1 | 3 | 2 | 3 | 5/5 |
| phone-cold-open | long task ms | 166 | 275 | 200 | 272 | 5/5 |
| phone-cold-open | heap MB | 2 | 2.1 | 2 | 2.1 | 5/5 |
| phone-older | page landed ms | 286 | 342 | 277 | 347 | 15/15 |
| phone-older | long tasks | 3 | 5 | 3 | 5 | 5/5 |
| phone-older | long task ms | 299 | 442 | 248 | 470 | 5/5 |

## lan (no proxy: the server and the page)

Journeys: cold-open, warm-open, resume, send, switch-room, older, picker-emoji, picker-gif, phone-cold-open, phone-older.

| journey | metric | A: main | B: main-again | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 4.7 | 3.9 | -0.8 | -17.0% |
| cold-open | scripts ms | 76.7 | 90.2 | +13.5 | +17.6% |
| cold-open | bootstrap ms | 94.9 | 108 | +13 | +13.7% |
| cold-open | paint ms | 160 | 172 | +11.5 | +7.2% |
| cold-open | socket ms | 125 | 140 | +14.4 | +11.5% |
| cold-open | rows ms | 160 | 172 | +11.5 | +7.2% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 815 | +0 | +0.0% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.1 | 2.7 | +0.6 | +28.6% |
| warm-open | scripts ms | 23.7 | 25.2 | +1.5 | +6.3% |
| warm-open | bootstrap ms | 84.2 | 88.3 | +4.1 | +4.9% |
| warm-open | paint ms | 58 | 58.2 | +0.2 | +0.3% |
| warm-open | socket ms | 35.6 | 35.6 | +0 | +0.0% |
| warm-open | rows ms | 75.6 | 76.9 | +1.3 | +1.7% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |
| resume | return to rows ms | 64.7 | 64.2 | -0.5 | -0.8% |
| send | own row ms | 1.3 | 1.3 | +0 | +0.0% |
| send | confirmed ms | 4.1 | 4.2 | +0.1 | +2.4% |
| switch-room | to pets (200) ms | 33 | 27.7 | -5.3 | -16.1% |
| switch-room | to lobby (20000) ms | 43.1 | 46.1 | +3 | +7.0% |
| older | page landed ms | 219 | 220 | +1.4 | +0.6% |
| older | long tasks | 0 | 0 | +0 | — |
| older | long task ms | 0 | 0 | +0 | — |
| picker-emoji | first: grid ms | 23.9 | 25 | +1.1 | +4.6% |
| picker-emoji | first: images ms | 642 | 671 | +29.7 | +4.6% |
| picker-emoji | first: requests in 2 s | 435 | 435 | +0 | +0.0% |
| picker-emoji | again: grid ms | 19.8 | 21 | +1.2 | +6.1% |
| picker-emoji | again: images ms | 504 | 512 | +7.9 | +1.6% |
| picker-emoji | again: requests in 2 s | 434 | 434 | +0 | +0.0% |
| picker-gif | first: grid ms | 11.9 | 10.9 | -1 | -8.4% |
| picker-gif | first: images ms | 48 | 48.4 | +0.4 | +0.8% |
| picker-gif | again: grid ms | 10.4 | 9.8 | -0.6 | -5.8% |
| picker-gif | again: images ms | 31.7 | 31.6 | -0.1 | -0.3% |
| phone-cold-open | html ms | 3.6 | 3.6 | +0 | +0.0% |
| phone-cold-open | scripts ms | 256 | 254 | -2.1 | -0.8% |
| phone-cold-open | bootstrap ms | 289 | 283 | -6 | -2.1% |
| phone-cold-open | paint ms | 640 | 618 | -21.9 | -3.4% |
| phone-cold-open | socket ms | 346 | 369 | +22.1 | +6.4% |
| phone-cold-open | rows ms | 640 | 618 | -21.9 | -3.4% |
| phone-cold-open | requests | 60 | 60 | +0 | +0.0% |
| phone-cold-open | cached | 3 | 3 | +0 | +0.0% |
| phone-cold-open | KB | 730 | 730 | +0 | +0.0% |
| phone-cold-open | long tasks | 2 | 2 | +0 | +0.0% |
| phone-cold-open | long task ms | 184 | 195 | +11 | +6.0% |
| phone-cold-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |
| phone-older | page landed ms | 298 | 306 | +7.7 | +2.6% |
| phone-older | long tasks | 4 | 4 | +0 | +0.0% |
| phone-older | long task ms | 371 | 373 | +2 | +0.5% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 3.9 | 7.6 | 3.2 | 4.9 | 5/5 |
| cold-open | scripts ms | 70.6 | 84.9 | 67.8 | 101 | 5/5 |
| cold-open | bootstrap ms | 91.8 | 104 | 86 | 123 | 5/5 |
| cold-open | paint ms | 148 | 240 | 147 | 210 | 5/5 |
| cold-open | socket ms | 119 | 135 | 116 | 165 | 5/5 |
| cold-open | rows ms | 148 | 240 | 147 | 210 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 815 | 815 | 5/5 |
| cold-open | long tasks | 0 | 1 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 55 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 2 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 1.9 | 3 | 2 | 3.2 | 5/5 |
| warm-open | scripts ms | 20.9 | 48.5 | 23.9 | 55.8 | 5/5 |
| warm-open | bootstrap ms | 82 | 125 | 84.5 | 129 | 5/5 |
| warm-open | paint ms | 55.5 | 80.7 | 54.6 | 92.8 | 5/5 |
| warm-open | socket ms | 33.1 | 82.1 | 35.3 | 68.5 | 5/5 |
| warm-open | rows ms | 73.3 | 111 | 73 | 118 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.9 | 2.1 | 5/5 |
| resume | return to rows ms | 61.3 | 66.1 | 59.7 | 67.2 | 5/5 |
| send | own row ms | 1 | 6.1 | 1 | 2.8 | 50/50 |
| send | confirmed ms | 3.3 | 13 | 3.4 | 9.6 | 50/50 |
| switch-room | to pets (200) ms | 26.5 | 38.8 | 26.6 | 35.7 | 5/5 |
| switch-room | to lobby (20000) ms | 40.5 | 43.5 | 43 | 51.3 | 5/5 |
| older | page landed ms | 215 | 231 | 219 | 235 | 15/15 |
| older | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| older | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| picker-emoji | first: grid ms | 22.9 | 55.2 | 22.5 | 26.8 | 5/5 |
| picker-emoji | first: images ms | 293 | 905 | 371 | 694 | 5/5 |
| picker-emoji | first: requests in 2 s | 435 | 435 | 435 | 435 | 5/5 |
| picker-emoji | again: grid ms | 19.3 | 23 | 19.8 | 25.1 | 5/5 |
| picker-emoji | again: images ms | 491 | 546 | 484 | 548 | 5/5 |
| picker-emoji | again: requests in 2 s | 434 | 434 | 434 | 434 | 5/5 |
| picker-gif | first: grid ms | 10.8 | 14.6 | 10.7 | 12.7 | 5/5 |
| picker-gif | first: images ms | 47.7 | 57 | 47 | 49.3 | 5/5 |
| picker-gif | again: grid ms | 8.4 | 12.7 | 8.9 | 12.1 | 5/5 |
| picker-gif | again: images ms | 30.8 | 48.1 | 31.2 | 33 | 5/5 |
| phone-cold-open | html ms | 3.2 | 4.2 | 3.3 | 4.8 | 5/5 |
| phone-cold-open | scripts ms | 244 | 302 | 242 | 294 | 5/5 |
| phone-cold-open | bootstrap ms | 278 | 338 | 267 | 326 | 5/5 |
| phone-cold-open | paint ms | 607 | 663 | 555 | 679 | 5/5 |
| phone-cold-open | socket ms | 342 | 417 | 338 | 411 | 5/5 |
| phone-cold-open | rows ms | 607 | 663 | 555 | 679 | 5/5 |
| phone-cold-open | requests | 60 | 61 | 60 | 60 | 5/5 |
| phone-cold-open | cached | 3 | 4 | 3 | 3 | 5/5 |
| phone-cold-open | KB | 730 | 730 | 730 | 730 | 5/5 |
| phone-cold-open | long tasks | 2 | 2 | 1 | 3 | 5/5 |
| phone-cold-open | long task ms | 179 | 210 | 130 | 260 | 5/5 |
| phone-cold-open | heap MB | 2.1 | 2.1 | 2.1 | 2.1 | 5/5 |
| phone-older | page landed ms | 290 | 345 | 283 | 365 | 15/15 |
| phone-older | long tasks | 3 | 5 | 3 | 4 | 5/5 |
| phone-older | long task ms | 274 | 461 | 297 | 446 | 5/5 |

All runs ended.
