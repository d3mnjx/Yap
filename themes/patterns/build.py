#!/usr/bin/env python3
"""Author the app's background-pattern tiles as SVG mask data-URIs.

The shipped patterns in wwwroot/app.css (--pattern-waves/-drops/-specks/
-specks-dense/-seigaiha) are generated here. To change a motif: edit PATTERNS,
run this script, open preview.html to judge the result over each theme's
colours, then paste the emitted "--pattern-*" lines over the ones in app.css.

Each tile is sparse: a few soft motifs scattered at varied positions/rotations,
none touching, none crossing the tile edge - which is ALL that "seamless"
requires; it does not mean the motifs form a continuous line or grid.

The URIs are masks: only alpha matters (shapes are drawn opaque black), the
colour comes from the consuming element's background-color, which is what lets
one shape serve every theme. The preview exaggerates tint alpha to 0.5 so the
shapes are judgeable; production alphas live in themes.css (~0.05-0.11).
"""
import urllib.parse

def uri(w, h, body):
    svg = f"<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{h}'>{body}</svg>"
    return "url(\"data:image/svg+xml," + svg.replace('<','%3C').replace('>','%3E').replace('#','%23') + "\")"

S = "stroke='black' fill='none' stroke-linecap='round'"
TILDE = "M0 0 q6 -6 12 0 t12 0"
DROP  = "M0 -6 C3 -2 5 1 5 3.5 A5 5 0 1 1 -5 3.5 C-5 1 -3 -2 0 -6 Z"
ARCS  = (f"<path d='M-14 0 a14 14 0 0 1 28 0' {S} stroke-width='1.5'/>"
         f"<path d='M-9 0 a9 9 0 0 1 18 0' {S} stroke-width='1.5'/>"
         f"<path d='M-4.5 0 a4.5 4.5 0 0 1 9 0' {S} stroke-width='1.5'/>")

def tapered_tilde(maxw=2.8, n=16):
    """Outline of the tilde with width maxw mid-stroke, ~0 at the tips.

    Samples the two quadratic Beziers of TILDE, offsets each point along the
    curve normal by half the local width, and closes top edge + reversed
    bottom edge into one fillable path. Width profile sin(pi*t)^0.8: full in
    the middle, pinched at both ends without a long skinny run-out.
    """
    import math
    segs = [((0, 0), (6, -6), (12, 0)), ((12, 0), (18, 6), (24, 0))]
    pts = []
    for si, (p0, c, p1) in enumerate(segs):
        for i in range(n + 1):
            if si == 1 and i == 0:
                continue  # joint point already sampled by the first segment
            t = i / n
            x = (1-t)**2*p0[0] + 2*(1-t)*t*c[0] + t*t*p1[0]
            y = (1-t)**2*p0[1] + 2*(1-t)*t*c[1] + t*t*p1[1]
            dx = 2*(1-t)*(c[0]-p0[0]) + 2*t*(p1[0]-c[0])
            dy = 2*(1-t)*(c[1]-p0[1]) + 2*t*(p1[1]-c[1])
            L = math.hypot(dx, dy) or 1.0
            pts.append(((x, y), (-dy/L, dx/L)))
    m = len(pts) - 1
    top, bot = [], []
    for i, ((x, y), (nx, ny)) in enumerate(pts):
        w = maxw * math.sin(math.pi * i / m) ** 0.8 / 2
        top.append((x + nx*w, y + ny*w))
        bot.append((x - nx*w, y - ny*w))
    return "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in top + bot[::-1]) + " Z"

# The dots of "specks" as (cx, cy, r), and the ones "specks-dense" adds between them.
SPECKS = [(8,10,1.4),(28,6,1.0),(50,14,1.8),(14,34,1.0),(40,38,1.5),(60,52,1.1),(22,56,1.6)]
SPECKS_EXTRA = [(46,60,1.2),(58,28,1.0),(6,48,1.2),(34,22,1.1),(52,44,1.4)]

def specks(dots):
    return "".join(f"<circle cx='{x}' cy='{y}' r='{r}' fill='black'/>" for x, y, r in dots)

PATTERNS = {
  # little waves - five tapered swooshes rising bottom-left -> top-right.
  # A stroke cannot vary its width along a path, so the tilde is a FILLED
  # OUTLINE computed by tapered_tilde(): the centreline offset by a width
  # profile that swells mid-stroke and pinches to nothing at the tips.
  # The gradient fill adds a gentle opacity fade on top (masks read alpha),
  # so the tips both narrow and melt. Shape defined once, <use>d five times.
  "waves": uri(104,104,
    "<defs><linearGradient id='f'>"
    "<stop offset='0' stop-color='black' stop-opacity='0.25'/>"
    "<stop offset='0.35' stop-color='black'/>"
    "<stop offset='0.65' stop-color='black'/>"
    "<stop offset='1' stop-color='black' stop-opacity='0.25'/>"
    "</linearGradient>"
    + f"<path id='w' d='{tapered_tilde()}' fill='url(#f)'/></defs>"
    + "".join(
      f"<use href='#w' transform='translate({x} {y}) rotate({r}) scale({sc})'/>"
      for x,y,r,sc in [
        (10,34,-45,1.25), (48,26,-41,0.8), (76,58,-48,1.0),
        (24,82,-44,0.6), (62,96,-46,0.9)])),

  # raindrops - eight per 140px tile with rotation jitter and a wide size
  # spread, the scatter quality taken from drops-scattered.svg (user-brought).
  "drops": uri(140,140,"".join(
    f"<g transform='translate({x} {y}) rotate({r}) scale({sc})'><path d='{DROP}' fill='black'/></g>"
    for x,y,r,sc in [
      (24,30,15,1.0),(80,19,-20,0.7),(121,49,30,1.2),(48,76,-10,0.85),
      (102,89,45,0.6),(22,116,-35,1.1),(75,127,10,0.75),(126,116,-15,0.9)])),

  # soft pebbles - organic blobs, from pebbles.svg (user-brought), converted to
  # a mask: background rect stripped, shapes opaque. Native 260px tile kept -
  # the large period is what makes the repeat hard to spot.
  "pebbles": uri(260,260,
    "<defs><path id='b' d='M0,-18 C12,-18 22,-8 20,4 C18,16 6,22 -6,19 "
    "C-18,16 -24,4 -20,-8 C-16,-18 -10,-18 0,-18 Z'/></defs>"
    + "".join(
      f"<use href='#b' fill='black' transform='translate({x} {y}) rotate({r}) scale({sc})'/>"
      for x,y,r,sc in [
        (55,60,10,1.0),(160,40,-25,0.7),(225,110,40,1.15),(100,150,-10,0.85),
        (195,185,15,0.6),(50,220,-35,1.1),(145,235,5,0.8)])),

  # pond ripples - concentric wobbly rings + stray dots, from ripples.svg
  # (user-brought). Ring strokes thicken as they scale outward, which reads as
  # the ripple spreading. Tea House's DM marker.
  "ripples": uri(260,260,
    "<defs><path id='r' d='M0,-15 C9,-16 16,-8 15,1 C14,10 6,16 -3,15 "
    "C-12,14 -17,6 -16,-3 C-15,-11 -8,-14 0,-15 Z'/></defs>"
    + "".join(
      f"<use href='#r' fill='none' stroke='black' stroke-width='1.5' transform='translate({x} {y}){rot} scale({sc})'/>"
      for x,y,rot,sc in [
        (72,82,'',1.0),(72,82,'',1.75),(72,82,'',2.5),
        (185,185,' rotate(25)',0.9),(185,185,' rotate(25)',1.5),(185,185,' rotate(25)',2.1),(185,185,' rotate(25)',2.7),
        (228,55,' rotate(-15)',0.6),(228,55,' rotate(-15)',1.05),
        (45,215,' rotate(10)',0.55),(45,215,' rotate(10)',0.95)])
    + "<circle cx='150' cy='60' r='1.5' fill='black'/>"
      "<circle cx='120' cy='200' r='1.5' fill='black'/>"
      "<circle cx='240' cy='140' r='1.5' fill='black'/>"),

  # phosphor specks - scattered soft dots, varied radii
  "specks": uri(64,64, specks(SPECKS)),
  # denser variant for Terminal DMs ("encrypted = denser"): the same dots, and five more
  "specks-dense": uri(64,64, specks(SPECKS + SPECKS_EXTRA)),
  # seigaiha fragments - PARKED, no longer shipped (Tea House DMs use ripples
  # now); kept for a future theme
  "seigaiha": uri(96,96,
    f"<g transform='translate(26 30) rotate(-6) scale(0.85)'>{ARCS}</g>"
    f"<g transform='translate(70 68) rotate(4) scale(0.85)'>{ARCS}</g>"
    f"<g transform='translate(74 20) scale(0.6)'><path d='M-14 0 a14 14 0 0 1 28 0' {S} stroke-width='1.5'/>"
    f"<path d='M-9 0 a9 9 0 0 1 18 0' {S} stroke-width='1.5'/></g>"),
}

BGS = [("discord-dark","#36393f","hsl(0 0% 100% / 0.5)"),
       ("terminal","#07090a","hsl(140 100% 60% / 0.5)"),
       ("neon-glow","#0d0820","hsl(190 90% 55% / 0.5)"),
       ("teahouse-noon","#e0e0a0","hsl(60 20% 20% / 0.5)")]

css_rules = "".join(
    f".pat-{name}{{-webkit-mask-image:{css};mask-image:{css}}}\n"
    for name, css in PATTERNS.items())

cells = ""
for name in PATTERNS:
    row = "".join(
        f'<div class="cell" style="background-color:{bg}">'
        f'<div class="pat pat-{name}" style="background-color:{tint}"></div>'
        f'<span>{label}</span></div>'
        for label,bg,tint in BGS)
    cells += f"<h2>{name}</h2><div class='row'>{row}</div>"

open("preview.html","w").write(f"""<!doctype html><meta charset=utf-8><style>
body{{margin:0;font:12px sans-serif;background:#222;color:#ddd;padding:12px}}
.row{{display:flex;gap:8px;margin-bottom:16px}}
.cell{{position:relative;width:330px;height:210px;border-radius:6px;overflow:hidden}}
.pat{{position:absolute;inset:0}}
.cell span{{position:absolute;left:8px;bottom:6px;opacity:.6}}
h2{{margin:6px 0}}
{css_rules}</style>{cells}""")
print("preview.html written")
# NOTE: tint alpha is exaggerated (0.5) so the shapes are judgeable; production stays ~0.05-0.11

PARKED = {"seigaiha"}  # authored but not shipped; app.css carries only the rest

print()
print("/* --- paste-ready (parked motifs excluded) --- */")
for name, css in PATTERNS.items():
    if name not in PARKED:
        print(f"    --pattern-{name}: {css};")
