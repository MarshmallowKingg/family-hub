# iPad Air 4 (A2316, MYFQ2B/A) landscape cupboard mount — adhesive fixing
# Axes: X = width along cupboard, Y = up the cupboard, Z = out from cupboard (Z=0 sits on cupboard / print bed)
import manifold3d as m
import numpy as np, trimesh

IPAD_W, IPAD_H, IPAD_T = 247.6, 178.5, 6.1    # Air 4 landscape
PLATE_T   = 3.0      # back plate
GAP       = 5.0      # air gap behind iPad (cooling + swell room)
SLOT      = IPAD_T + 0.9
LIP_T     = 2.5
Z_BACK    = PLATE_T + GAP            # iPad back face
Z_FRONT   = Z_BACK + SLOT            # front of slot
Z_TOP     = Z_FRONT + LIP_T          # front of lips
BOT_LIP   = 5.0      # bottom lip covers 5 mm of bezel (bezel ~10 mm)
TOP_LIP   = 6.0      # top lip covers 6 mm
TOP_GAP   = 7.0      # lift iPad 7 mm into top channel to clear 5 mm bottom lip
FLOOR     = 4.0
SIDE_CLR  = 0.7
SIDE_T    = 1.5
HALF_W    = IPAD_W/2 + SIDE_CLR + SIDE_T   # 126.0 -> 252 mm wide, fits 256 mm P1S bed
Y_BOT     = -FLOOR
Y_TOPCH   = IPAD_H + TOP_GAP
Y_TOP     = Y_TOPCH + 3.0
BORDER    = 15.0

def box(x0,x1,y0,y1,z0,z1):
    return m.Manifold.cube([x1-x0,y1-y0,z1-z0]).translate([x0,y0,z0])

# --- back frame (open window = lighter + airflow)
frame = box(-HALF_W, HALF_W, Y_BOT, Y_TOP, 0, PLATE_T)
win_l = box(-HALF_W+BORDER, -15, Y_BOT+BORDER, Y_TOP-BORDER, -1, PLATE_T+1)
win_r = box(15, HALF_W-BORDER, Y_BOT+BORDER, Y_TOP-BORDER, -1, PLATE_T+1)
frame = frame - win_l - win_r

# --- standoff ribs (iPad back rests on these, leaves 5 mm air gap)
ribs = m.Manifold()
for x in (-HALF_W+3, -10, HALF_W-15+3):
    ribs += box(x, x+9 if x!=-10 else 10, 20, IPAD_H-20, PLATE_T, Z_BACK)
for x0 in (-HALF_W+3, -40, 30, HALF_W-15+3):
    w = 12 if abs(x0) > 50 else 10
    ribs += box(x0, x0+w, 2, 14, PLATE_T, Z_BACK)
    ribs += box(x0, x0+w, IPAD_H-14, IPAD_H-2, PLATE_T, Z_BACK)

# --- bottom ledges: two 40 mm segments, kept clear of volume buttons whichever way up
ledges = m.Manifold()
for x0 in (-60, 20):
    ledges += box(x0, x0+40, Y_BOT, 0, PLATE_T, Z_TOP)            # floor
    ledges += box(x0, x0+40, 0, BOT_LIP, Z_FRONT, Z_TOP)          # front lip
    ledges += box(x0, x0+40, 0, BOT_LIP, PLATE_T, Z_BACK)         # back support

# --- top channel: one central 70 mm tab (clear of Touch ID / volume buttons)
top = box(-35, 35, Y_TOPCH, Y_TOP, 0, Z_TOP)                      # ceiling
top += box(-35, 35, IPAD_H-TOP_LIP, Y_TOPCH, Z_FRONT, Z_TOP)      # front lip
top += box(-35, 35, IPAD_H-TOP_LIP, Y_TOPCH, PLATE_T, Z_BACK)     # back support

# --- side stops: two bumps per side, gap in middle for USB-C plug
sides = m.Manifold()
for sx in (-1, 1):
    xi = sx*(IPAD_W/2 + SIDE_CLR); xo = sx*HALF_W
    for y0 in (55, 108):
        sides += box(min(xi,xo), max(xi,xo), y0, y0+16, 0, Z_FRONT)
        # arm back to the frame border
        sides += box(min(xo, xo - sx*BORDER), max(xo, xo - sx*BORDER), y0, y0+16, 0, PLATE_T)

# --- sensor pod under bottom edge for ESP32-C3 SuperMini + LD2410C (front open, snap-on cover)
POD_W, POD_H, POD_D, WALL = 60, 32, 24, 2.0
py1 = Y_BOT; py0 = Y_BOT - POD_H
pod = box(-POD_W/2, POD_W/2, py0, py1, 0, POD_D)
pod -= box(-POD_W/2+WALL, POD_W/2-WALL, py0+WALL, py1-WALL, PLATE_T, POD_D+1)
pod -= box(POD_W/2-WALL-1, POD_W/2+1, py0+10, py0+19, PLATE_T, PLATE_T+9)   # USB-C cable notch (right side)
pod += box(-POD_W/2, POD_W/2, py1-1, py1+0.01, 0, PLATE_T)                  # join to frame

mount = frame + ribs + ledges + top + sides + pod

# --- pod cover (print separately, face down). mmWave passes through 2 mm PLA/PETG fine.
CLR = 0.25
cover = box(-POD_W/2, POD_W/2, 0, POD_H, 0, 2)
iw, ih = POD_W-2*WALL-2*CLR, POD_H-2*WALL-2*CLR
rim = box(-iw/2, iw/2, WALL+CLR, WALL+CLR+ih, 2, 6) - box(-iw/2+1.2, iw/2-1.2, WALL+CLR+1.2, WALL+CLR+ih-1.2, 1.9, 7)
cover = cover + rim

def to_tri(man):
    mesh = man.to_mesh()
    return trimesh.Trimesh(vertices=np.array(mesh.vert_properties)[:, :3], faces=np.array(mesh.tri_verts))

tm = to_tri(mount); tc = to_tri(cover)
tm.export('/home/claude/mount/ipad-air4-hub-mount.stl')
tc.export('/home/claude/mount/sensor-pod-cover.stl')
scene = trimesh.Scene()
scene.add_geometry(tm, node_name='mount')
scene.add_geometry(tc.apply_translation([0, -80, 0]), node_name='cover')
scene.export('/home/claude/mount/ipad-hub-mount.3mf')
b = tm.bounds
print('mount bounds mm:', np.round(b[1]-b[0], 1), 'watertight', tm.is_watertight, 'vol cm3', round(tm.volume/1000, 1))
print('cover bounds mm:', np.round(tc.bounds[1]-tc.bounds[0], 1))
