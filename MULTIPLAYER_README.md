# Subway Surfers – race multiplayer (v2)

Run:  cd PokiSubwaySurfers_MP && python3 -m http.server 8000
Open: http://localhost:8000/index.html?mp=1   (plain index.html is still the normal single-player game)

* Backend: Firebase (config in mp-config.js, rules must allow read/write on "mp-rooms" and "mp-lobbies").
  Add ?net=local to test with several tabs of one browser with no internet.
* Logo: drop your Logo.png next to index.html to use it offline. If the file is missing, it is loaded from
  https://raw.githubusercontent.com/BruneCoding/ArborUltra/main/Logo.png (change in mp-config.js).
* Lobby list: click Join. Everyone gets the same seeded track. Pick character + board in the lobby (synced).
* Race: translucent real character models with animation + board, name tags.
* Host options: No coin (round ends when anyone collects a coin), Hoverboards on/off.
* After you crash you spectate runners still going (arrow buttons / A-D). When all are out: full leaderboard.

## Accounts, ranks & leaderboards (added)
- `mp-accounts.js` is loaded before `mp-hook.js`. Home screen has Log in / Sign up, rank badge + progress bar, and a Leaderboard button.
- Results screen is now a podium (top 3) + list; logged-in players get Rank Points for winning lobby races (solo = 0).
- Leaderboard tabs: Rank Points, This Week, Most Wins, High Score, Best Distance, Coins.
- Local mode stores accounts in this browser only; set Firebase in `mp-config.js` for shared accounts/boards.

## Host options, ready, kick, chat (added)
- 12 new host options (objective + target, time limit, fixed seed, countdown, boards per run, blind race, hide nametags, no spectating, disable pause, standings display, No-coin "others keep playing"). Editable live in the lobby by the host.
- Ready button for non-hosts; with >2 players at least 50% (host counts as ready) must be ready. Host can Kick.
- Lobby chat (bottom-left in lobby) and Universal chat (home screen), 30 messages max. Firebase paths: `mp-chat/global`, `mp-rooms/<code>/chat`.
- Position bar (top) and ROUND display during races; name colour + badge customisation.

## Sync / engine notes
- The stock loop clamps each frame to 100 ms, so slow machines ran in slow motion and fell behind. While racing, `maxDeltaTime` is raised to 200 ms and smoothing is off (restored after the race).
- Ghosts are created during the countdown (not on the GO frame) to avoid the start hitch.
- Spectating now copies the watched player's lane, height, jump and camera pose, and hides the guard.
- "Disable pause" overrides pause / blur-pause and hides the pause button for the race.
- Firebase rules: see `database.rules.json` (adds mp-chat/global, mp-rooms/<code>/chat).

## Poki7 notes
- **Publish the database rules** (Firebase console -> Realtime Database -> Rules -> paste `database.rules.json` -> Publish). Without this, accounts, leaderboard and universal chat show a "permission denied" message.
- Chunk RNG keys are now position-based (no per-client counter); a console warning `[MP] WORLD DESYNC` appears if two clients' sequences ever diverge.

## Poki8 notes
- **Sitelock removed**: the real Poki SDK `<script>` (game-cdn.poki.com) is gone from index.html, the bundled SDK files in `scripts/` are blanked, the
  remote-loader URL in the site chunk is neutralised, and `window.PokiSDK` is a locked, non-overridable stub. Any attempt to inject a poki-sdk/sitelock script is ignored.
- **UI v8**: Minecraft-style home with animated panorama + 3D-tilt character, Fortnite-style lobby & customise (outfit / board / nametag plates, effects, rank icon),
  bubble chat (lobby chat stays visible, fading, during races; Enter to type), podium leaderboard/results, lobby browser with search + filters, keyed live race HUD.
- Desync detector now compares chunk hashes from both sides and shows a toast if tracks diverge.

## Poki9 notes
- **Home screen redesigned** to the "Subway Surfers Multiplayer" hub: logo, coin/trophy pills, Join-a-lobby list (live, with JOIN buttons + Create lobby), Universal chat (faces, no bubbles/borders, collapsible),
  character on a pedestal with arrows + thumbnail row, Leaderboard (Global/Friends tabs), Log in / Sign up card and a big PLAY button. Code: `showHome` + `css4` (v9) in mp-hook.js.
- **Seed sync verified**: same seed -> identical chunk sequence at normal speed and with the CPU throttled 4x; a different seed -> a different track (headless Chromium test). The generator wraps Math.random per chunk key (seed|sequence|sub-index).
- **White canvas hardening**: panorama canvases are freed whenever the overlay is hidden; a watchdog shows a "reload game" link if the main WebGL context is lost.
- NOT done (hand-over): true 3D rotatable character stage, 3D lobby with all players + join/leave animations, outfit-texture (-tex-1/-tex-2) picker, random generated panorama, lobby-chat minimise/scale, slimmer race top bar.

## Poki9Two (overlay) notes
- Ready fix, draggable top bar / scoreboard / lobby chat (double-click to reset), chat minimise + resize buttons, race bar compact (-) and hide (x) buttons with a restore button.
- v10 3D stage: the real game world with live .pk avatars behind home/lobby/customise; drag = rotate, wheel = zoom, random camera angle per visit, nametags projected over each avatar, drop-in / poof-out animations.
- Outfit style (Classic / Remix / Midnight = the -tex, -tex-1, -tex-2 textures) and pose pickers in Customise; synced to other players.
KNOWN ISSUES (verified in headless tests): in a 2-player lobby only one avatar was visible (the other showed a tag only); in Customise the avatar sits behind a train prop / off to the left and was not visible; outfit texture swap and own-hero outfit in races are unverified; home screen not redesigned to the reference. Race start, desync detector (no desync flagged) and HUD controls worked.

## Poki11 notes
- **Randomised 3D diorama (`mp-scene.js`)**: the home / lobby / customise background is now a full custom scene
  rebuilt from a fresh seed every time the stage opens. It is generated from the game's own chunk data
  (`assets/data/chunks-full.json`): trains, pillars, signals, gates, platforms and coins are read out of real
  route chunks and placed along three tracks. Six themes (Sunset Yard, Neon Night, Morning City, Golden Hour,
  Snow Morning, Dawn Patrol) randomise sky, trains, walls, skyline and lighting. Includes moving + parked trains,
  spinning coins, drifting clouds, blinking signals, glowing lamp posts and a station platform with **glowing pads**
  that characters land on (one pad per player, spacing matches the stage roster).
- **Home screen**: the double character selection (arrow carousel + thumbnail row) is removed. One button remains:
  guests see "Select Character", logged-in accounts see "Customise" - the character grid lives in the customise screen only.
- **Default pose is Hero** (`run_HighScore_main`) for new players; the saved pose still wins if the player picked one.
- **Customise screen**: new "Accessories" tab with 14 items (Crown, Halo, Top hat, Prop cap, Horns, Antenna,
  Bunny ears, Shades, Gold chain, Bow tie, Cape, Wings, Jet pack). Accessories render as animated stickers above the
  character on the stage, appear next to the name in lobby rows and on nametags in races, and sync to other players.
- **Nametags in races**: your own nametag is now projected above your character too (not just opponents),
  unless the host turns "Hide nametags" on. Projection now uses viewport space (the old canvas-rect maths
  collapsed to 0 on some builds - this is what broke nametags before).
- **Lobby restyled to the Fortnite design system**: dark navy glass panels, cyan uppercase headers, toggle-switch
  host options, gold lobby code plate and the big yellow skewed START/READY button.
- **Universal + lobby chat**: own messages align right, others left, avatar heads are faded into the background
  (opacity + desaturate) like the reference UI.
- **UI polish**: chunky Subway-Surfers buttons (orange gradients, thick white borders, hard drop shadows) are now
  used consistently across home, lobby, customise and modals.

## Poki13 notes (this build)
- **Loading screen (`mp-loader.js`)**: a locked-perspective 3D mockup of Subway Surfers built from the real
  chunk data (`assets/data/chunks-full.json` - trains, blockers and coins are read out of actual route chunks),
  with a blocky Jake mockup running. Click left / right (or ArrowLeft / ArrowRight) to dodge trains, Space to
  jump; the mouse adds a slight parallax. Progress follows the real game boot (`MP.ready()`); when loading
  completes the frozen frame **dissolves into ~5000 particles** and fades away. Falls back to a styled DOM
  loader if WebGL is unavailable.
- **Performance**: the nametag projector now caches the camera view-projection matrix (one invert per frame
  budget instead of per ghost per frame), the canvas rect is cached (no `getBoundingClientRect` every frame),
  label transforms are only written when they move, and `pushState` skips network writes when nothing changed.
  Measured against the Poki12 baseline: identical engine profile in headless, with the mod layer overhead
  removed (remaining hitches come from the engine's own chunk generation).
- **Spectate camera**: the rig now floats IN FRONT of the spectated runner and looks back at them, so you
  watch them charge straight at the camera (was the standard chase view from behind).
- **Fortnite lobby (exact replica)**: top nav (LOBBY / BATTLE PASS / LOCKER / ITEM SHOP / PROFILE /
  LEADERBOARDS / STORE), season panel (SEASON 2, level shield, XP bar, LVL reward), FREE PASS card with tier
  progress + gold banner + daily challenges, glowing character pads with crown + READY / NOT READY status,
  party pill with roster dropdown (kick), gem counter, big INVITE button, GAME MODE / Squad panel with
  Change Mode, Squad Fill switch, ready line and the big yellow START / READY button, plus a
  "X joined the party" notification feed.
- **Chat (reference style)**: visual-novel layout - big faded character portraits behind the bubbles, name
  above the bubble, timestamp inside it, own messages right-aligned green, system lines ("X join chat")
  centred with an avatar, and a green START button on any message containing `join <CODE>`.
- **Nametag customisation**: 9 plate styles (None/Pill/Neon/Glass/Flag/Gold/Hex/Bracket/Banner), 8 text
  effects (None/Glow/Shadow/Rainbow/Pulse/Stroke/Flicker/Bounce), 3 sizes, opacity slider and an underline
  colour - all live-previewed on the 3D stage and synced to other players.
- **Social layer (`mp-social.js`)**: friends (add by username, accept / decline requests, remove, online
  presence), friend requests ("friended by"), lobby invites and profile extras. Storage:
  `mp-friends/<key>/{list,in,out}`, `mp-presence/<key>`, `mp-invites/<key>/<id>` on Firebase; localStorage +
  BroadcastChannel between tabs in local mode. Publish the updated `database.rules.json`.
- **Host invites**: the INVITE button lists every player (search + online badges). Invited players get a
  top banner with the lobby code and JOIN / decline buttons (auto-expires). Hosts can invite from the lobby;
  logged-in players receive banners anywhere.
- **Profile system**: bio (editable), live 3D render of your character - click the stage (or LIFT) to lift
  the character up, toolbar to reset pose / cycle pose / open locker / play-pause / spin - plus the full
  stat block: leaderboard position, rank + RP, weekly RP, account age (lifespan), member since, races, wins,
  win rate, best streak, total distance raced, best distance, coins, high score, friends list with online
  dots, pending requests ("friended by") and a share row (copy link / X / Reddit / WhatsApp). Deep-link any
  profile with `?mp=1&profile=<name>`.
- **Hoverboards**: new host options - "Infinite hoverboards" (boards never run out) and board counts up to
  25 per run.
- **Bug fixes**: joining a new lobby no longer leaves the old connection running (ghost connections used to
  fight over player state - ready flags flickered), kick buttons, ready sync, results RP/accuracy, and the
  lobby season-card layout are fixed. Publishing the updated database rules is still required for Firebase.

## Poki14 notes (this build) — full UI/UX redesign
- **Unified design system (LABY.net inspired)**: all eight legacy CSS layers (v7–v13) were replaced by one
  coherent system - near-black charcoal surfaces (#0a0d14/#10141d), thin #232b3a borders, 12px panels,
  restrained blue (#3e7bfa) + purple accents, success green / danger red states, 'proxima' body text and
  'torus' headings, consistent spacing, hover transitions and press feedback everywhere. One shared top
  navigation (PLAY/LOBBY · LOCKER · LEADERBOARDS · PROFILE + account chip) is used by home and lobby.
- **Item Shop + Battle Pass removed**: the ITEM SHOP / STORE nav buttons, the shop modal, the battle-pass
  modal, FREE PASS card, daily-challenges button and their actions are gone from the code (not hidden).
- **Minimal loading screen (`mp-loader.js` rewritten)**: only the centred logo and ONE thin progress bar.
  The inline `LoadingBar` in index.html is now a pure progress source that forwards every real update to
  `window.MPLoader.set`; completion is gated on `MP.ready()` (never faked to 100%), then it fades out.
  The old 3D mockup/particle loader was removed.
- **Player profile rebuilt (LABY.net style)**: full-width header - player avatar window with the live 3D
  character (the VIEWED player's model now renders, not always your own), kicker, big username, ID row
  with a working COPY-ID button, rank/level/online chips, editable bio - plus a six-tile stats strip.
  Two-column body: LEFT character + skin history (clickable outfits) + cosmetics + social (friends,
  requests, add-by-username); RIGHT progression (XP bar + next-level requirement), ranked (emblem,
  division bar, RP, next-rank), match statistics, **match history** (last 12 real races), **achievements**
  (14, computed from real stats), account info + share row. Deep links still work (`?mp=1&profile=<name>`).
- **Levels & XP**: every finished race awards real XP (opponents + win + distance + coins, capped); the
  profile stores `xp`, `hist`. Level curve 1000 + 250*(N-1) per level. XP bars animate in the results
  screen (+XP line, LEVEL N, LEVEL UP! banner) and on home/lobby/profile.
- **Ranked system redesigned**: the eight emoji rank icons are replaced by designed vector emblems (one
  shape per rank: Rookie circle, Bronze shield, Silver diamond, Gold crest, Platinum star, Diamond gem,
  Master shield-check, Legend flame) with metallic gradients and I/II/III division pips. Divisions split
  each rank into thirds; rank emblems render in profiles, lobby, party rows, nametags (optional), the
  spectator bar and leaderboards.
- **Fortnite-inspired lobby (reworked, shop-free)**: top nav with coins + account chip, SEASON panel
  (level shield, XP bar, rank emblem row), GAME MODE card (mode name, Change Mode, Squad Fill switch),
  lobby info card (code, tags, copy link), PARTY panel with level chips + rank sigils + online dots +
  kick buttons + INVITE, camera-recentre button and the READY/START action card. 3D characters stay on
  the glowing pads.
- **Spectator camera: THREE modes** (`specMode`, remembered per session):
  1. **Third person** - genuine chase rig BEHIND and above the runner (was facing the wrong way in
     Poki13), drag to orbit, wheel to zoom, camera kept above train-roof height so it does not clip;
  2. **Aerial** - high overhead orbit looking down at the runner (real 3D, adjustable angle + zoom);
  3. **Free view** - WASD move, mouse-look (drag), Space up, Ctrl/C down, Shift sprint, wheel adjusts
     speed, world-bounded, independent of any player.
  The polished selector bar shows all modes with vector icons, the spectated player (avatar, level, rank,
  score), prev/next player buttons (smooth camera glide to the new target, works from Free View too) and
  an EXIT button that opens a "Spectator ended" card (Back to lobby / Leave) without leaving the race.
  Keyboard: 1/2/3 switch modes, A/D or arrows cycle players (bracket keys in Free View). Targets that
  disconnect/crash are re-picked automatically; the rig only touches the LOCAL spectator camera.
- **Chat**: kept the reference visual-novel look (faded portraits, name above the bubble, timestamp,
  centred system lines, lime START pill on join codes); own messages are now accent-blue; universal chat
  lives in a home panel, lobby chat is the draggable/minimisable/sizable floating panel.
- **Performance**: removed `backdrop-filter` blur from all large panels (GPU cost), nametag/stage tags
  hidden where unused, HUD layering fixed (#mp-hud back to a fixed full-screen pass-through layer),
  fewer per-frame style writes. No new per-frame allocations in the rig.
- **Bug fixes in this build**: spectator mode resets correctly after exit/back-to-lobby; remembered
  camera mode applies its orbit envelope on boot; local-mode profiles now merge the REAL stats store
  (profiles showed the account key instead of the display name and zero stats); results screen is a true
  two-column layout; winner card no longer clips the XP/RP block; host-option labels no longer use emoji.

## Poki15 notes
- Home fills the window and auto-scales (1500x860 design grid, `fitHome`).
- Universal/lobby chat redone as visual-novel style: big floating heads that bleed off the panel edge and fade out, translucent bubbles, green START pill.
- Home/lobby stage is a dark Fortnite-style studio (navy dome, glossy floor, glowing 3D pads with light beams); the Subway Surfers world is hidden. Pads are lit for you / host / ready players and dim otherwise. Drag/wheel still rotate and zoom.
- Debug: set `window.__MP_FAKE=['a','b','c']` in the console to preview a multi-pad row.

## Poki18 notes (this build) — complete multiplayer update

- **Five UI themes (Client Settings)**: Midnight, Frosted Glass (real glassmorphism: translucent blurred panels), Light Mode (full light surfaces), Neon, Ember. Each theme restyles the whole interface (panels, buttons, inputs, HUD, chats, modals) via `body[data-theme]` and pairs with a matching 3D environment. An independent **3D environment** picker offers six scenes (Midnight Yard, Frosted Glass, Morning City, Neon Night, Golden Hour, Snow Morning). Preferences persist locally.
- **Music selector (Client Settings)**: Default `theme.ogg`, Orchestral `themeOrch.ogg`, Trap 1 `themeTrap.ogg`, Trap 2 `themeTrap2.ogg`, upload custom music (stored in IndexedDB, max 20 MB), and mute. The engine's theme request is transparently redirected; optional tracks are probed first and flagged "missing" until you drop the file next to `index.html` (or into `assets/music/`), so nothing ever breaks.
- **Stopwatch (host option)**: live race timer in the HUD header using the server clock (identical on every client). In No Coin Mode every player's time until their first coin is tracked and shown in the scoreboard, results and spectator leaderboard.
- **Ranked mode**: RANKED PLAY button on the home screen (logged-in only). Dedicated matchmaking screen: your profile left, the opponent right, VS ring + "Finding Ranked Match" centre with radar animation. Pick Coin or No Coin before searching. Firebase queue with atomic transaction claims (`mp-ranked/queue`); BroadcastChannel pairing in local mode. The claimant hosts the lobby (max 2, ranked flags stamped on the room). Ranked results move RP (+30..+46 win scaled by lobby size, -14 loss, floor 0) and are stored per-mode (`rw`/`rl` + `md` buckets). You can also invite any logged-in player to a ranked duel (banner shows mode + code).
- **Leaderboards reorganised**: three categories — UNRANKED and RANKED each split into Coin Mode / No Coin Mode (High Score / Best Distance / Most Wins / Coins / Races boards + personal stat cards), plus CLASSIC (the original all-time boards). Switching is animated.
- **Join active lobbies**: racing lobbies are joinable (SPECTATE button). Late arrivals get a live spectator screen with the real standings and automatically become normal players when the next round begins.
- **Spectator leaderboard**: draggable live standings panel (`B` key or the bar-chart button in the spectator bar). Remembers its position.
- **Lobby ownership & permissions**: hosts can grant five granular co-owner permissions (kick, edit settings, start races, invite, manage co-owners) via the gear button on any roster row. Co-owner buttons only appear when permitted. Revoke by removing all permissions.
- **24-hour persistent lobbies**: logged-in hosts can create a persistent lobby that stays discoverable and joinable for 24 hours (`mp-persist`, auto-expired). If the host leaves, the lobby reopens with a stand-in host; when the original host returns the crown is handed back automatically. Admins can also claim host.
- **Lobby animations**: animated create/join overlay (logo, spinner, step dots) and smooth transitions into lobbies.
- **Chat**: the lobby chat collapses into a small floating chat icon with an unread badge (arrow button in the chat header).
- **Account badges**: earned automatically from real account data — New Account (<24h), Veteran (30d), Senior Racer (1y), 50/100/500 Games, 25/100 Wins, Level 25, Gold Racer — shown on profiles (chips + badge shelf). OWNER (crown) and custom admin badges also appear on nametags.
- **Developer admin console (Brune)**: authorisation lives in the **backend** (`mp-admin/grants/brune`, written automatically at login and verified against the account database — not localStorage; the console additionally re-verifies the password). Features: custom badge studio (name, icon, colour), badge assignment per user, and lobby control (join any lobby + CLAIM HOST). The OWNER crown badge uses a crown icon and is displayed on Brune's nametag and profile. Open it from the settings row (visible only to the owner) or from the browser DevTools console with `MP18.admin.open()` — the username is case-insensitive (`brune`, `Brune`, `BRUNE` all log into the same account key `brune`).
- **Login & accounts**: premium split login screen with a full forgot-password flow (recovery email verified against the account record, then a new salted hash is written — stored passwords are never exposed). Signup optionally stores a recovery email; the profile screen can update it.
- **Backend paths added**: `mp-ranked/*`, `mp-persist`, `mp-admin/*` (see `database.rules.json` — republish it in the Firebase console).
