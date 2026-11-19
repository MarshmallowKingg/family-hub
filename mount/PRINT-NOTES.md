# iPad Air 4 hub mount: print and fit

**Parts:** `ipad-air4-hub-mount.stl` (252 × 224.5 × 24 mm) and `sensor-pod-cover.stl`. The `ipad-hub-mount.3mf` file has both laid out on one plate.

## Bambu Studio (P1S)
- **Filament:** PETG is best for a kitchen (heat and grease). PLA is fine away from the oven.
- **Orientation:** flat, back face down, as exported.
- **Width:** at 252 mm it only just fits the 256 mm plate, so turn brim and skirt off and centre it.
- **Supports:** Tree (auto). They're only needed under the lips on the bottom ledges and the top tab.
- **Strength:** 3 walls and 15% gyroid infill, about 130 g.
- **Pod cover:** print it face down with no supports. Don't use a metallic or carbon-fill filament for it, because it blocks the radar.

## Fitting
- Clean the cupboard side with IPA.
- Fix the mount with **Command Large picture-hanging strips** (removable). Put 4 pairs on the frame border and 1 on the pod. Press each one for 30 seconds and leave it 1 hour before hanging the iPad.
- Use 3M VHB only if a permanent fix is OK, because it can lift a vinyl-wrap finish when you remove it.
- **Fitting the iPad:** with the screen facing out, push the top edge up into the top tab (7 mm of travel), swing the bottom in past the ledges and let it drop. Fit it with the volume buttons on the **top edge**.
- The side bumps leave a gap in the middle for the USB-C plug. A right-angle USB-C cable keeps it tidy.
- The pod's right-hand notch takes the ESP32's USB-C cable. Stick the LD2410C to the inside of the pod cover with foam tape.
- Run both cables to a dual-port 20 W+ USB charger at the socket. A 2 m cable is enough, plus adhesive cable clips.

## Fit to check on the first print
The slot is 7.0 mm for the 6.1 mm iPad, with 0.7 mm clearance each side. If it's tight, edit the values at the top of `mount.py` and re-run `python3 mount.py`.
