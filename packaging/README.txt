VeoClone for Windows
====================

VeoClone turns two iPhone videos of a football match into one video where
the camera follows the ball. Everything happens on this PC: your videos are
never uploaded to the internet.

Full step-by-step guide:
https://github.com/rossdelport/veoclone#readme


STARTING VEOCLONE
-----------------
1. Keep this whole folder together (for example in Documents\VeoClone).
   Don't run VeoClone from inside the zip file.
2. Double-click VeoClone.exe.
3. The first time, Windows may say "Windows protected your PC".
   Click "More info", then "Run anyway".
   If Windows says "Part of this app has been blocked" (Smart App Control),
   see "If something goes wrong" below.
4. A black window opens, then your browser opens the VeoClone editor.
   KEEP THE BLACK WINDOW OPEN while you use VeoClone (you can minimise it).
   It also shows the folder where your matches are saved.
5. If Chrome or Edge asks for permission to connect to devices or apps on
   your network or this computer, click "Allow".

If the browser did not open, go to:  http://127.0.0.1:47863/
The online editor also works while VeoClone is running:
https://rossdelport.github.io/veoclone/


FILMING (on both iPhones)
-------------------------
- Settings > Camera > Record Video: 4K at 30 fps, HDR Video OFF,
  Auto FPS OFF (older iPhones: Auto Low Light FPS off), Lock Camera on
  (if your phone has these). With Auto FPS on, the two halves drift apart
  in dim light or under floodlights.
- Camera app: Video, tap 0.5x. Hold the phones sideways.
- Side by side, as high as you can, at the halfway line. Angle them
  outwards: left phone films the left half, right phone the right half,
  with a small overlap in the middle.
- Start both recordings within a few seconds of each other, then clap once
  near both phones. Don't touch the phones until the end.
- Stopped at half-time? Make one VeoClone match per half.


MAKING A VIDEO
--------------
1. New match: type a name. Drop the left phone's video on "Left phone" and
   the right phone's video on "Right phone" (mixed them up? click "Swap left
   and right").
2. Pick your iPhone model and the lens: "Ultra wide (0.5x)" if you tapped
   0.5x when filming. Not sure? Leave it on "Not sure". Pick a camera style
   and click Start.
3. Wait (a full match can take an hour or more). Keep the black window
   open. VeoClone keeps the PC awake while it works.
4. Open the editor: fix the camera where needed, trim, cut out half-time.
5. Export > Make video > Download (or Show in folder).


WHERE YOUR FILES ARE
--------------------
The folder shown in the black window, usually Videos\VeoClone (or
VeoClone in your user folder, for example C:\Users\Sam\VeoClone, if
OneDrive backs up your Videos folder). Each match has a folder inside its
"projects" folder; finished videos are in the match's "exports" folder.
Deleting a match in VeoClone deletes that folder, including its finished
videos, so save the videos you want to keep first.


IF SOMETHING GOES WRONG
-----------------------
- "VeoClone isn't running": open VeoClone.exe again and keep its window
  open. Use Chrome or Edge.
- "Part of this app has been blocked" (Smart App Control): Windows has no
  "Run anyway" for this. Open Start, type Smart App Control, open Smart App
  Control settings and choose Off, then open VeoClone.exe again. (On some
  versions of Windows 11 it can't be switched back on afterwards.)
- AI very slow ("AI on the main processor"): update your graphics card
  driver and restart the PC.
- Washed-out colours: switch HDR Video off on the phones next time.
- Bent or warped picture: click "Change phone or lens" (in the editor or
  on the match page) and pick the right iPhone and lens.
- "We couldn't line up the two videos": the videos may be the wrong way
  round. Click "Swap left and right and try again".
- Videos not lined up: start the phones closer together and clap.
- Each match folder has a log.txt file; include it when you ask for help.


WHAT IS IN THIS FOLDER
----------------------
VeoClone.exe        the VeoClone program
web\                the editor that opens in your browser
models\             the AI model that finds the ball
ffmpeg.exe, ffprobe.exe, av*.dll, sw*.dll, postproc*.dll
                    FFmpeg, for reading and writing video
onnxruntime.dll, DirectML.dll
                    run the AI on your graphics card
vcruntime140*.dll, msvcp140*.dll
                    Microsoft Visual C++ runtime
LICENSE             VeoClone's licence (GNU AGPL v3.0)
licenses\           licences of the other programs included


CREDITS AND LICENCE
-------------------
VeoClone is free software under the GNU Affero General Public License v3.0
(see LICENSE). Source code: https://github.com/rossdelport/veoclone
It is built on Reco Video Stitcher by the Reco project (AGPL-3.0):
https://github.com/reco-project/video-stitcher
The AI model (yolo26n) comes from the Reco release and is based on
Ultralytics YOLO (AGPL-3.0).
FFmpeg (GPL) builds by BtbN: https://github.com/BtbN/FFmpeg-Builds
(FFmpeg source code: https://ffmpeg.org). ONNX Runtime and DirectML are
by Microsoft. Their licences are in the "licenses" folder.
VeoClone is not made by, or connected with, Veo Technologies.
