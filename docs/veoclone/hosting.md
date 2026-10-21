# Free hosting: how VeoClone is published

VeoClone costs nothing to host. There is no server to rent: the heavy video
work runs on each user's own PC. GitHub does the rest for free, because the
repository is public:

| What | Where people get it | Made by |
|---|---|---|
| The online editor | <https://rossdelport.github.io/veoclone/> (GitHub Pages) | `.github/workflows/veoclone-pages.yml` |
| The Windows download (`VeoClone-windows.zip`) | [Releases page](https://github.com/rossdelport/veoclone/releases) | `.github/workflows/veoclone-windows.yml` |
| Automatic checks of every change | Actions tab | `.github/workflows/veoclone-ci.yml` |

All three run by themselves on GitHub's computers ("GitHub Actions") when
changes are pushed. Nobody has to build anything by hand.

## One-time settings (the repository owner clicks these once)

1. **Keep the repository public.** GitHub Pages and Actions minutes are free
   for public repositories. (Settings › General › Danger Zone › Change
   repository visibility.)
2. **Turn on GitHub Pages.** Settings › **Pages** › Build and deployment ›
   **Source**: choose **GitHub Actions**. Nothing else to pick on that page.
3. **Allow Actions to run.** Settings › **Actions** › General:
   - **Actions permissions**: "Allow all actions and reusable workflows" is
     simplest. If you prefer to limit them, allow actions by GitHub plus
     `dtolnay/rust-toolchain` and `Swatinem/rust-cache` (Reco's own
     workflows also use `awalsh128/cache-apt-pkgs-action`,
     `EmbarkStudios/cargo-deny-action` and `rustsec/audit-check`).
   - **Workflow permissions**: leave the default, "Read repository contents
     and packages permissions". Each workflow asks only for the extra rights
     it needs (publishing a release, publishing the Pages site).
4. **Releases**: nothing to set. If you see **"Enable release
   immutability"** (Settings › General › Releases), leave it **off**: the
   "latest build" download is replaced with each new build.
5. **Publish for the first time.** If the first push to `main` happened
   before step 2, open **Actions › VeoClone Pages › Run workflow** (on
   `main`) once. After that it runs by itself.

GitHub creates a `github-pages` environment the first time Pages is
published. It only allows `main` to publish; leave it like that.

## What happens automatically

| When | What happens |
|---|---|
| Any push or pull request | **VeoClone CI** checks the editor (type check, tests, build) and the helper (formatting, clippy, tests, an export test on a software GPU). |
| Push to `main` or a `claude/...` branch | **VeoClone Windows** builds the VeoClone folder on a Windows computer, starts it once to check it works, and keeps it as a download on the run's page (Artifacts › VeoClone-windows) for 90 days. |
| Push to `main` | The same build also replaces the download in the **"VeoClone for Windows (latest build)"** pre-release (tag `helper-latest`). This is the link the user guide gives out. **VeoClone Pages** publishes the editor. |
| Tag `veoclone-v...` | **VeoClone Windows** makes a normal, permanent release with the zip, for example "VeoClone v0.2.0". |

To make a permanent release: change `version` in
`crates/veoclone-helper/Cargo.toml` (so `VeoClone.exe --version` matches),
push it to `main`, then:

```bash
git tag veoclone-v0.2.0
git push origin veoclone-v0.2.0
```

Reco's own `release.yml` reacts to tags starting with `v`; it is set to
ignore `veoclone-v...` tags.

## How to check it worked

- **Actions** tab: the newest runs have green ticks.
- <https://rossdelport.github.io/veoclone/> opens the editor. It says
  "VeoClone isn't running" until VeoClone is started on that PC; that is
  expected.
- The **Releases** page lists "VeoClone for Windows (latest build)" with
  `VeoClone-windows.zip` under Assets.

## Limits worth knowing

- The Windows build is the slow one (it compiles everything; allow up to
  an hour). Builds of a branch that get a newer push are cancelled; builds of
  `main` always finish.
- GitHub Pages: 1 GB per site. The editor is well under 1 MB.
- Release files can be up to 2 GB each. `VeoClone-windows.zip` is a few
  hundred MB at most.

## How the online editor talks to VeoClone on your PC

The page at `https://rossdelport.github.io` sends requests to
`http://127.0.0.1:47863`, which is VeoClone on the user's own PC. Browsers
allow this only because VeoClone says it is allowed (CORS, plus Chrome's
local network permission, which may show a one-time "Allow" question).
VeoClone only listens on the PC itself, so nobody else on the network can
reach it.

If the repository moves to another account or name, update the addresses in:
the helper's allowed origins (`crates/veoclone-helper/src/api.rs`,
`default_origins`), the download link in `web/src/ui/health.ts`, the links in
`README.md`, `packaging/README.txt` and this page, and
`docs/veoclone/DESIGN.md`.
