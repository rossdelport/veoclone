# VeoClone

Film a football match with two iPhones (or two GoPros), and VeoClone turns the two videos into
one video where the camera follows the ball, like a Veo camera.

- **Download for Windows:** [VeoClone-windows.zip](https://github.com/rossdelport/veoclone/releases/download/helper-latest/VeoClone-windows.zip)
  (or see all downloads on the [Releases page](https://github.com/rossdelport/veoclone/releases))
- **Online editor:** <https://rossdelport.github.io/veoclone/> (VeoClone must be running on your PC)

## What VeoClone does

1. You film the match with two iPhones side by side, up high. Each phone films
   one half of the pitch.
2. VeoClone lines the two videos up using their sound, joins them into one
   wide view of the whole pitch, and an AI watches the match and steers a
   "camera" that follows the ball.
3. In the editor you can point the camera somewhere else wherever the AI got
   it wrong, trim the start and end, cut out half-time, zoom in or out, and
   make the camera smoother.
4. You export a normal MP4 video that plays everywhere and is easy to share.

Everything happens on your own PC. Your videos are never uploaded to the
internet, not even when you use the online editor.

## What you need

- **A Windows 10 or 11 PC with a decent graphics card**, for example an AMD
  Radeon RX 6000 series or an NVIDIA GeForce RTX. A weaker graphics card
  works too, just more slowly.
- **Plenty of free disk space**: about 40 GB for each full match. Phone videos
  are big.
- **Google Chrome or Microsoft Edge.** The editor runs in your web browser.
- **Two iPhones with an ultra wide (0.5×) lens** (iPhone 11 or newer, but not
  the iPhone 16e or iPhone Air, which have no 0.5× lens). Two identical
  phones work best, but different iPhones are fine.
- **Something to hold both phones side by side, up high**: a tall tripod or
  pole with a mount for two phones. The higher, the better.
- Power banks for both phones, and enough free space on each phone (about
  20 GB each for a full match).
- **Or two identical GoPros** (HERO9 Black or newer works best; other action
  cameras may work too), see [Filming with GoPros](#filming-with-gopros).

## One-time setup

1. **Download** [VeoClone-windows.zip](https://github.com/rossdelport/veoclone/releases/download/helper-latest/VeoClone-windows.zip).
   - If Chrome or Edge says the file **isn't commonly downloaded** (or blocks
     it), press **Ctrl + J** to open the list of downloads, find
     VeoClone-windows.zip and choose **Keep** (Chrome may call it **Download
     suspicious file**; Edge may ask again: **Show more › Keep anyway**).
     Browsers say this about files that few people have downloaded yet.
   - If that link doesn't work yet, open the
     [VeoClone Windows builds](https://github.com/rossdelport/veoclone/actions/workflows/veoclone-windows.yml)
     page, click the newest run with a green tick, scroll down to
     **Artifacts** and click **VeoClone-windows**. (You need to be signed in
     to GitHub for this.)
2. **Unzip it**: right-click the downloaded file, choose **Extract All…**,
   click **Browse…**, choose your **Documents** folder and click **Extract**.
   You now have a folder called **Documents\VeoClone**. Don't run VeoClone
   from inside the zip file.
3. **Start it**: open the VeoClone folder and double-click **VeoClone.exe**
   (it may just show as "VeoClone").
4. The first time, Windows may say **"Windows protected your PC"**. Click
   **More info**, then **Run anyway**. Windows says this about programs it
   doesn't know yet; you only need to do it once. (If Windows instead says
   **"Part of this app has been blocked"** or mentions **Smart App Control**,
   see [If something goes wrong](#if-something-goes-wrong).)
5. A black window opens, and then your browser opens the VeoClone editor.
   **Keep the black window open while you use VeoClone.** Closing it stops
   VeoClone (it is fine to minimise it). The black window also shows the
   folder where your matches are saved.
6. If Chrome or Edge asks for permission to **connect to devices or apps on
   your network or this computer**, click **Allow**. VeoClone only talks to
   your own PC.

Next time, start VeoClone from the **Start menu** (VeoClone adds itself
there the first time it runs), or double-click VeoClone.exe again. You can
also have it start by itself: see [Updates and starting with Windows](#updates-and-starting-with-windows).

## Updates and starting with Windows

**VeoClone updates itself.** You only download the zip once. When a new
version comes out, VeoClone downloads it in the background, checks it, and
installs it when it is not busy: never while it processes a match, makes a
video or receives a video. It then restarts by itself in a few seconds, in
the same black window; the editor in your browser waits and carries on.
Your matches are not touched.

- The home page of the editor has a **VeoClone on this PC** box at the
  bottom. It says "VeoClone is up to date", or "Update ready — it installs
  when nothing is processing" with an **Install now** button, or explains
  in plain words what went wrong (VeoClone then keeps the version you have
  and tries again later).
- Don't want automatic updates? Untick **Update VeoClone automatically**
  there. **Check for updates** then updates it when you choose.
- **Start VeoClone when Windows starts**: tick it in the same box. VeoClone
  then starts by itself in a minimised window when you sign in to Windows,
  without opening the browser, so it is always ready (and keeps itself up
  to date). Untick it to stop that.
- Keep the VeoClone folder somewhere you can change files, such as
  Documents (not Program Files), so VeoClone can update itself there.

## How to film

**Settings on both iPhones** (open **Settings › Camera › Record Video**).
Give both phones the same settings. If their videos still come out
different (for example from two different iPhone models), VeoClone makes a
matching copy first, which takes longer.

- Choose **4K at 30 fps**.
- Switch **HDR Video off**. Otherwise the colours look washed out.
- Set **Auto FPS** to **Off** (on older iPhones: switch **Auto Low Light
  FPS** off). Otherwise the phones film fewer frames when the light is dim,
  for example under floodlights, and the two halves slowly drift apart.
- If you see **Lock Camera**, switch it **on** (the phone then keeps the same
  lens all the time).

**Setting up at the pitch:**

- Open the Camera app, choose **Video** and tap **0.5×** on both phones.
- Hold the phones **sideways** (landscape), both the same way up.
- Put them **side by side, as high as you can**, level with the halfway line.
- **Angle them outwards**: the left phone films the left half of the pitch,
  the right phone the right half. The two pictures should **overlap a
  little in the middle** (about 15%, so the centre circle shows in both).
- Tilt them down only as much as you need for the whole pitch to fit, from
  the near touchline to the far one, and keep them **level side to side**
  (not leaning). The more level the phones are, the more natural the camera
  looks when it turns; if the picture still leans, **Straighten picture** in
  the editor fixes it.
- Turn on **Airplane Mode** so calls don't interrupt the recording, and plug
  in the power banks.

**Recording:**

- Press record on **both phones within a few seconds of each other**.
  VeoClone uses the sound to line the two videos up. A loud clap near both
  phones just after you start helps.
- **Don't touch or move the phones** until the end.
- Keep recording through half-time if you can. If you stop at half-time, you
  get two videos per phone: make **one VeoClone match per half**.

### Filming with GoPros

Use **two identical GoPros**, side by side up high, set up like the phones
above (left GoPro films the left half, right GoPro the right half, a little
overlap in the middle). On **both** GoPros set:

- **Resolution 4K, 30 fps, aspect ratio 16:9.**
- **Lens: Wide.** (Not Linear, SuperView or HyperView.)
- **HyperSmooth: Off.** Stabilisation crops and moves the picture, and the two
  views no longer join.
- **Horizon Levelling / Horizon Lock: Off**, for the same reason.
- **Anti-Flicker: 50 Hz** in the UK, Europe, Australia and New Zealand
  (**60 Hz** in North America), so floodlights don't flicker.

GoPros record their own level (an accelerometer), so the picture usually
comes out straight without touching **Straighten picture**. In VeoClone,
under **Which camera?**, choose **GoPro or other action camera – detect
automatically**: VeoClone reads the model and the Lens setting from the
video file. If that doesn't work (VeoClone then says so under **Good to
know**), choose your GoPro model and **Wide** or **Linear** instead.

A GoPro saves a long recording as several files: a new one about every 8
to 12 minutes in 4K (every 4 GB), for example GX010042.MP4, GX020042.MP4,
GX030042.MP4… (older GoPros: GOPR0042.MP4, GP010042.MP4, GP020042.MP4…). A
full match is about 8 to 10 files per camera. You don't need to join them:
**drop all the files from one camera into its box** (see below). Don't
rename them: VeoClone reads the order from the names.

**Getting the videos onto your PC:**

- On each iPhone, go to **Settings › Apps › Photos** (on older iPhones
  **Settings › Photos**) and under **Transfer to Mac or PC** choose **Keep
  Originals**.
- Plug the iPhone into the PC with its cable, unlock it and tap **Trust**.
- Open **File Explorer › This PC › Apple iPhone › Internal Storage › DCIM**
  and copy the match video (the newest .MOV file) to a folder on your PC.
- Rename the files straight away, for example **left.MOV** and
  **right.MOV**, so you don't mix them up.
- **From a GoPro:** put its memory card in a card reader (or connect the
  GoPro with its USB cable), open **DCIM › 100GOPRO** and copy all the
  **.MP4** files of the match (their names end in the same four numbers)
  into a folder of their own, one folder per GoPro, for example **Left
  GoPro** and **Right GoPro**. Don't rename them. You can leave out the
  .LRV and .THM files: VeoClone doesn't need them.

## Making a video, step by step

1. **Start VeoClone** (double-click VeoClone.exe). The editor opens in your
   browser. At the top right it should say **Connected**.
2. Click **New match** and type a name, for example "U12s v Rovers".
3. Drag the left phone's video onto **Left phone** and the right phone's video
   onto **Right phone** (or click a box to choose the file). Left and right
   are as seen from behind the phones, facing the pitch. Mixed them up?
   Click **Swap left and right**.

   **GoPro:** drop all the files from one camera into its box (select them
   all in the folder and drag them together, or click the box and choose
   them all). VeoClone lists them in the order it joins them, for example
   "9 parts · 1:32:10 · 35.2 GB", and warns you if a file seems to be
   missing or comes from a different recording. Click **×** next to a file
   to take it out. VeoClone joins the parts itself, without changing the
   GoPro's files.
4. **Which camera and lens filmed this?** Under **Which camera?** pick your
   iPhone model (for GoPros see [Filming with GoPros](#filming-with-gopros)). Under **Which lens?** pick **Ultra wide (0.5×)** if you
   tapped 0.5× when filming (as this guide says), otherwise **Normal (1×)**.
   If you don't know the model, or it isn't in the list, leave it on **Not
   sure**. Two different iPhones? Tick **The two phones are different
   models** and choose the iPhone and lens for the **Left phone** and the
   **Right phone**. You can change this later.
5. **Camera style**: **Broadcast** (calm, like TV; best for most matches),
   **Action** (follows the ball more closely), **Wide** (keeps all the
   players in the picture) or **Follow the ball** (keeps the ball itself in
   the middle at a fixed zoom; try it when the camera keeps drifting back to
   the middle of the pitch or to people next to it). You can change it later.
   **Widest view**: how far the camera may zoom out, for example when the
   play goes to the far corner. **Natural (like Veo)** (the default) stays
   close to the play, so the sides of the picture never look stretched;
   **Wide** zooms out a bit more; **Widest** zooms out as far as it needs to,
   and then players at the sides can look stretched, like a fisheye.
   **AI accuracy**: **Best** (the AI looks at every frame; recommended) or
   **Faster** (every 3rd frame: the AI step takes about a third of the time,
   but the camera reacts a little later).
6. Click **Start**. Keep the page open until both videos have been sent to
   VeoClone (a GoPro video is sent file by file; if sending stops, click
   **Try again**: files already sent are skipped). Then VeoClone works
   through four steps: checking the videos
   (and making them match if the phones filmed in different formats),
   lining them up and joining them, making a preview, and AI ball tracking.
   This takes a while: for a full match, allow an hour or more. You can leave
   the page, but **keep the black VeoClone window open**. VeoClone keeps the
   PC awake while it works (the screen may still turn off). On a laptop,
   keep it plugged in and the lid open.
7. When it says **Your match is ready**, click **Open the editor**. If
   VeoClone noticed something you should know (for example washed-out
   colours, or the two videos didn't line up well), it says so under **Good
   to know**, on this page and in the editor.

**In the editor:**

- The big picture is the **camera view**: what your video will look like.
  Below it are the play buttons and the **timeline**.
- The tools are on the left: **Camera**, **Fixes**, **Straighten**, **Pitch**,
  **Text**, **Trim** and **Tips**. Click one and its settings show next to it.
  The first time you open a match, **Tips** shows what is worth doing first.
- The small **Whole pitch** map in the corner of the picture shows the whole
  pitch. The green box shows where the camera is pointing. Click or drag in
  it to point the camera somewhere else. Make it bigger, or put it away, with
  the buttons on the map.
- You can also drag inside the camera view to move the camera, and scroll
  the mouse wheel there to zoom in or out at that moment.
- Each time you move the camera, VeoClone adds a **fix**: the camera keeps your
  view around that moment, then eases back to the AI. **How long a fix lasts**
  (under **Fixes**) sets how long it stays.
- The **timeline** shows the whole match in three rows: **Video** (the parts
  you keep; cut parts are striped), **Fixes** and **Text**. Click a fix marker
  to jump to it; press **Delete** to remove the selected fix.
- Under **Trim**, **Set start here** and **Set end here** trim the video.
  **Cut out a section** removes a part, for example half-time.
- **Zoom** (under **Camera**) makes the whole video wider or closer.
  **Smoothness** calms down quick camera moves.
- **Widest view** (under **Camera**): **Natural (like Veo)**, **Wide** or
  **Widest**. Neither the Zoom slider nor a fix zooms out further than it
  allows (zooming in is not limited). Changing it shows at once and runs the
  AI camera again, usually in a few seconds (VeoClone asks first when it
  would take longer); your trims, fixes and text are kept.
  Matches made with an older VeoClone keep the widest camera they had until
  you pick one; a tip under **Tips** offers **Natural**.
- A **Good to know** box under **Tips** lists anything VeoClone noticed
  while processing. Click **×** to hide it.
- Picture **leans more and more when the camera turns** left or right (the
  phones pointed down), or the far side slopes? Use **Straighten** on the
  left: click **Look left**, **Look centre** and **Look right** to point
  the preview across the pitch (this is not saved as a fix), then move
  **Tilt** (how much the phones pointed down) and **Level** (lean left or
  right) until the far side of the pitch looks level everywhere and goal
  posts stand straight up. Thin lines over the picture help while you move
  the sliders. Your fixes keep looking at the same place, and the export uses
  the same setting. GoPro footage usually needs nothing: the camera measures
  its own level and VeoClone starts from that (**Reset** goes back to it).
- **Mark the pitch** (under **Pitch**, also offered under **Tips** the
  first time you open a match): click the corners of the pitch on the big
  picture, going round it, plus a few points along any edge that looks
  curved. **Undo last point** and **Start again** fix mistakes. Save it and
  click **Run the AI again**: the AI camera then ignores everyone outside the
  pitch (substitutes, parents, a game on the next pitch). This takes a few
  seconds, because VeoClone reuses what the AI saw the first time.
- To try another **camera style**, **widest view** or **AI accuracy**, open
  the match page (Change, under **Camera**) and click **Run the AI again**.
  This also takes only a few seconds, except when switching from **Faster**
  to **Best** (the AI then has to look at every frame of the video again).
- Picture bent, or the two halves don't join? Click **Change phone or lens**
  (under **Camera**). See
  [If something goes wrong](#if-something-goes-wrong).
- Keyboard: **Space** play/pause, **← →** one frame, **Shift + ← →** five
  seconds, **K** add a fix with the current view, **Ctrl + Z** undo.
- Your changes are saved by themselves.

**Adding text** (team names, the date, a player's name, anything):

- Under **Text** on the left, click **Match title**, **Player name** or
  **Text**. A match title ("Home team vs Away team" and today's date) is
  shown at the top for the whole video; a player name or text is shown for
  5 seconds from the playhead.
- Type your words in the box. Press **Enter** for a new line. The camera
  view shows the text straight away.
- Pick where it goes on the picture (**Place**) and how big it is (**Size**).
- To change when it is shown, move the playhead and click **Show from here**
  or **Hide from here**. The bars in the timeline's **Text** row show when
  each text is on screen; click a bar to change that text.
- Click the bin next to a text to delete it (**Undo** brings it back).
- Your text is added to the video when you export it, looking just like it
  does in the camera view.

**Exporting:**

1. Click **Export**.
2. Choose the size (**1080p** is recommended and plays everywhere; 1440p and
   4K are sharper but bigger and slower to make) and the quality.
3. Click **Make video** and wait until it is finished. You can keep editing
   meanwhile. Keep the black VeoClone window open.
4. Click **Download**, or **Show in folder** to open the folder with your
   video.

## Where your files are kept

- Everything VeoClone makes is in one folder. The black VeoClone window
  shows it when it starts ("Your matches are saved in …"). Usually it is
  **Videos\VeoClone**. If OneDrive backs up your Videos folder, VeoClone uses
  a **VeoClone** folder in your user folder instead (for example
  **C:\Users\Sam\VeoClone**), so that tens of gigabytes per match aren't
  uploaded to OneDrive. (If you already have a Videos\VeoClone folder,
  VeoClone keeps using it.)
- Each match has its own folder inside the **projects** folder there, with
  VeoClone's own copy of the two phone videos (a GoPro video as its separate
  files, left.001.mp4, left.002.mp4…, plus a matching copy when the phones
  filmed in different formats), the preview and your finished
  videos (in the **exports** folder). The match folders have code names, so
  the easiest way to find a finished video is the **Show in folder** button
  in the editor.
- **To free up space**, delete matches you don't need any more on the
  VeoClone home page. This deletes VeoClone's copy of the phone videos **and
  the finished videos of that match**, so download or copy the videos you want
  to keep first. Files elsewhere on your PC or on the phones are not touched.
- You can also delete single finished videos in the editor's export list.
- Once a match is in VeoClone, it has its own copy of the phone videos, so
  you can delete the copies you made from the phones if you need the space.

## If something goes wrong

**"VeoClone isn't running" or "VeoClone not running"**
- Check that the black VeoClone window is open. If you closed it,
  double-click VeoClone.exe again.
- Use Chrome or Edge. If you clicked **Block** when the browser asked about
  devices or apps on your network, click the icon to the left of the web
  address, allow the network access again, and reload the page.
- Open the editor that VeoClone itself provides: <http://127.0.0.1:47863/>.
  It always works while the black window is open.
- If the black window says VeoClone **is already running**, another
  VeoClone window is open somewhere. Use that one, or restart the PC.

**Windows says "Part of this app has been blocked", or mentions Smart App Control**
- Smart App Control is a Windows 11 setting that blocks programs Windows
  doesn't know yet, and it has no "Run anyway" button. VeoClone is new and
  not signed by a big company, so it can be blocked.
- The only way round it is to switch Smart App Control off: open **Start**,
  type **Smart App Control** and open **Smart App Control settings**, then
  choose **Off**. Then double-click VeoClone.exe again (and click **More
  info › Run anyway** if Windows asks).
- On some versions of Windows 11, Smart App Control can't be switched back
  on afterwards. Your PC is still protected by Microsoft Defender (Windows
  Security).

**The AI is very slow, or it says "AI on the main processor (slow)"**
- VeoClone could not use your graphics card for the AI and is using the main
  processor instead, which is much slower. Update your graphics card driver
  (AMD Software: Adrenalin Edition, or the NVIDIA app), restart the PC and
  start VeoClone again.
- Make sure you start VeoClone.exe from the full VeoClone folder, with all
  the other files next to it.
- Point at **Connected** at the top right to see which graphics card
  VeoClone found.

**The colours look washed out or grey**
- The phones filmed in HDR. Switch **HDR Video** off on both phones before
  the next match (Settings › Camera › Record Video).

**The picture looks bent or warped, or the two halves don't join well**
- The wrong iPhone or lens may be selected. Click **Change phone or lens**
  (in the editor under **Camera**, or on the match page), pick the iPhone
  model and the lens that filmed the match, and click **Process again**.
  VeoClone processes the match again with the videos it already has. This
  takes about as long as the first time, and the editor can't be used
  meanwhile. Your trims and fixes are kept.
- Check that both phones used the same lens and the same settings, and did
  not move during the match. If the two phones are different iPhone models,
  tick **The two phones are different models** and pick each one.

**The picture leans when the camera turns left or right**
- The phones pointed down (or leaned a little). In the editor, use
  **Straighten picture**: **Look left**, **Look centre**, **Look right**,
  and move **Tilt** and **Level** until the far side looks level each time.
  Next time keep the phones as level as you can.
- If a corner of the picture goes black at the very edge of the pitch after
  straightening, zoom in a little there (the export shows the same).

**"We couldn't line up the two videos", or the two halves are in the wrong place**
- The left and right videos may be the wrong way round. Click **Swap left
  and right and try again** (on the match page after processing, it is
  **Swap left and right**). Nothing is sent to VeoClone again.

**The videos are not lined up (things jump where the two halves meet)**
- VeoClone lines the videos up using their sound. Next time, start both
  phones closer together (within a few seconds) and clap near both phones
  just after you start. Make sure nothing covers the microphones.
- If the two halves are fine at the start but drift apart later, one phone
  probably had **Auto FPS** on (VeoClone then says so under **Good to
  know**). Set it to **Off** before the next match (Settings › Camera ›
  Record Video).

**The picture looks like a fisheye: players at the sides look stretched when play goes to the far side**
- The camera zoomed out a long way. A flat picture that wide stretches
  whatever is at its sides (at the widest, a player at the edge can look
  about twice as wide as in the middle). Set **Widest view** to **Natural
  (like Veo)** under **Camera** in the editor: the camera then stays at most
  about 57° wide, like Veo's, and it takes a few seconds.
- If the camera then misses play at the far side, try **Wide**, or add a
  fix there (drag the picture).

**The camera keeps going back to the middle (the halfway line), or to people next to the pitch**
- **Mark the pitch** in the editor and run the AI again, so people outside
  the pitch don't pull the camera away.
- Try the **Follow the ball** camera style. It follows the ball itself
  rather than the group of players. If the ball is hard to see (small, far
  away, against a crowd), the camera may stop when it loses the ball.
- Use **AI accuracy: Best** so the AI looks at every frame.
- For moments it still gets wrong, add a fix (drag the picture).

**GoPro: "A part seems to be missing" or "These files seem to come from different recordings"**
- All the files of one GoPro recording end in the same four numbers
  (GX01**0042**.MP4, GX02**0042**.MP4…), and the two digits before them
  count up (01, 02, 03…; older GoPros start with GOPR0042.MP4). Copy all of
  them from the memory card and drop them all into the box together. Take
  out files of other recordings with the **×** next to them.
- If a part really is gone, VeoClone can still join the others, but the
  video jumps where the part is missing, and the two cameras no longer
  line up after it.
- If a match says some files of a video haven't been sent yet (sending
  stopped), drop all the files of that camera into its box again and press
  **Start**: the files VeoClone already has are skipped.

**"VeoClone couldn't recognise the camera from the video file"**
- You chose **detect automatically** but the video file doesn't say which
  camera filmed it (iPhone videos never do, and edited or joined files may
  lose it). Click **Change phone or lens** and choose your camera and lens.

**Processing stopped half-way**
- If the PC was switched off or restarted, or the black window was closed,
  open the match and press **Try again**.
- If the match was ready before (for example you were changing the camera
  style), VeoClone keeps the earlier result, so you can go on editing.

**"VeoClone couldn't update itself"** (on the home page, in the **VeoClone
on this PC** box)
- Nothing is broken: VeoClone keeps the version you have and tries again
  later. **Try again** checks at once.
- "Is this PC connected to the internet?": updates need the internet once
  in a while; everything else works without it.
- "VeoClone can't update itself because some of its files are missing from
  its folder": VeoClone.exe was moved out of its folder. Download VeoClone
  again (your matches are kept).
- If the update keeps failing, download VeoClone again and unzip it over
  your old VeoClone folder (your matches are kept: they are in a different
  folder).

**Still stuck?** The black VeoClone window shows what it is doing, and each
match folder (see [Where your files are kept](#where-your-files-are-kept))
has a **log.txt** file. Please include it when you ask for help.

## Online editor or local editor?

- **Online:** <https://rossdelport.github.io/veoclone/>. Always the newest
  editor. It still needs VeoClone running on your PC, and your videos stay on
  your PC.
- **Local:** <http://127.0.0.1:47863/>. The editor that comes with VeoClone.
  It works without the internet.

---

## For developers

VeoClone has two parts. The contract between them is
[docs/veoclone/DESIGN.md](docs/veoclone/DESIGN.md).

- **Helper** ([crates/veoclone-helper](crates/veoclone-helper)): a Rust
  program that runs on the user's PC as a local HTTP server on
  `127.0.0.1:47863`. It stores matches on disk and runs calibration, AI ball
  tracking (ONNX Runtime, DirectML on Windows) and export in-process with the
  Reco crates. Shipped as `VeoClone.exe`.
- **Editor** ([web](web)): a static site (Vite + TypeScript, no framework)
  hosted on GitHub Pages and also served by the helper. Its WebGL preview
  re-implements Reco's projection, and it sends the final camera path to the
  helper, so the preview matches the export.

**Build and run** (prerequisites as in [README.reco.md](README.reco.md):
Rust 1.92, FFmpeg development libraries, clang, pkg-config):

```bash
cargo build --release -p veoclone-helper
target/release/veoclone-helper --no-open --web-dir web/dist --model path/to/yolo26n_640.onnx

cd web
npm ci
npm run dev    # editor on http://localhost:5173, talks to the helper on 127.0.0.1:47863
npm run mock   # a pretend helper for editor work (see web/dev/README.md)
```

The AI models come from Reco's
[v0.5.2 release](https://github.com/reco-project/video-stitcher/releases/tag/v0.5.2).
Helper options: `--port`, `--data-dir`, `--web-dir`, `--model`,
`--allow-origin`, `--no-open`, `--minimized`, `--version`.
Builds made by CI carry their commit and date (`VEOCLONE_BUILD_SHA`,
`VEOCLONE_BUILD_DATE`) and update themselves from the `helper-latest`
release's `latest.json`; local builds are development builds and never do
(design: [DESIGN.md 4.11](docs/veoclone/DESIGN.md#411-veoclone-updates-itself)).

**Tests:**

```bash
cargo test -p veoclone-helper
cargo test -p veoclone-helper -- --ignored export_frame_alignment   # needs ffmpeg and a GPU (llvmpipe works)
python3 crates/veoclone-helper/scripts/update_e2e.py   # self-update: two builds, a pretend release, a real restart (Linux)
cd web && npm run typecheck && npm test && npm run test:ui
```

**CI, downloads and hosting** (details in
[docs/veoclone/hosting.md](docs/veoclone/hosting.md)):

- `veoclone-ci.yml`: editor typecheck, tests and build; helper fmt, clippy,
  tests and the self-update test (every push and pull request).
- `veoclone-windows.yml`: builds the Windows folder (VeoClone.exe, FFmpeg,
  ONNX Runtime + DirectML, models, editor) and smoke-tests it. Pushes to the
  repository's default branch (whatever it is called; today
  `claude/happy-einstein-iqtkqs`) update the `helper-latest` pre-release in
  place (the zip, then `latest.json`, which installed copies read to update
  themselves); a `veoclone-v*` tag makes a normal release.
- `veoclone-pages.yml`: publishes the editor to GitHub Pages on pushes to
  the default branch. One-time click first: Settings › Pages › Source:
  **GitHub Actions**.
- Reco's own workflows (`rust.yml`, `release.yml`, `build-test.yml`,
  `test-build-gui.yml`) only run by hand here.

## Credits and licence

- VeoClone is built on [Reco Video Stitcher](https://github.com/reco-project/video-stitcher)
  by the Reco project (AGPL-3.0). Reco's own documentation is in
  [README.reco.md](README.reco.md).
- The AI model (yolo26n) comes from the Reco release and is based on
  Ultralytics YOLO (AGPL-3.0).
- The Windows download also includes FFmpeg (GPL, builds by BtbN), Microsoft
  ONNX Runtime and DirectML, and the Microsoft Visual C++ runtime. The
  licences of FFmpeg, ONNX Runtime and DirectML are in the `licenses` folder
  of the download.
- VeoClone is free software under the GNU Affero General Public License v3.0
  (see [LICENSE](LICENSE)).
- VeoClone is not made by, or connected with, Veo Technologies.
