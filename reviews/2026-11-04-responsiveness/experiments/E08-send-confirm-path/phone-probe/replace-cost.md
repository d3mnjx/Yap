# E08: one replaceMessage of the own row on the phone (CPU x4), build A, 20 times

- synchronous redraw (listeners, renderRow, replaceWith): median 2.45 ms, min 1.80, max 3.90
- forced style and layout after it: median 4.35 ms, min 1.70, max 6.60
- redraw plus layout: median 6.80 ms, min 3.90, max 10.50
- baseline forced layout without a replace: median 0.00 ms, min 0.00, max 0.70
- rows with the text after each replace: 1 (one row, redrawn in place)
- server PID 633498
