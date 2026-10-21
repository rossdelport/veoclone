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

The download and the online editor are published from the repository's
**default branch** (the one GitHub shows first; Settings › General › Default
branch), whatever it is called. Today that is `claude/happy-einstein-iqtkqs`.

## One-time settings (the repository owner clicks these once)

1. **Keep the repository public.** GitHub Pages and Actions minutes are free
   for public repositories. (Settings › General › Danger Zone › Change
   repository visibility.)
2. **Turn on GitHub Pages.** Settings › **Pages** › Build and deployment ›
   **Source**: choose **GitHub Actions**. Nothing else to pick on that page.
   This is the only click the online editor needs.
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
5. **Publish for the first time.** Open **Actions › VeoClone Pages › Run
   workflow** and click **Run workflow** (the branch it offers is the
   default branch). Do the same for **VeoClone Windows** if the Releases page
   has no "VeoClone for Windows (latest build)" yet. After that both run by
   themselves on every push to the default branch.
6. **Old "Bump …" pull requests.** Reco's automatic dependency updates
   (Dependabot) are switched off in this repository. If the **Pull requests**
   tab still lists "Bump …" pull requests from Dependabot, close them
   (**Close pull request**, then **Delete branch**). Don't merge them.

### Changing the default branch later

If you make another branch the default later (for example a new `main`),
the download and the online editor follow by themselves: nothing in the
workflows needs to change. Two things to know:

- The Windows build only runs on `main` and `claude/...` branches, so give
  the default branch one of those names.
- GitHub creates a `github-pages` environment the first time Pages is
  published, and it may only allow the branch that was the default then. If
  **VeoClone Pages** then fails with "not allowed to deploy to github-pages",
  open Settings › **Environments** › **github-pages** and add the new
  default branch under **Deployment branches and tags**.

## What happens automatically

| When | What happens |
|---|---|
| Any push or pull request | **VeoClone CI** checks the editor (type check, tests, build) and the helper (formatting, clippy, tests, an export test on a software GPU). |
| Push to `main` or a `claude/...` branch | **VeoClone Windows** builds the VeoClone folder on a Windows computer, starts it once to check it works, and keeps it as a download on the run's page (Artifacts › VeoClone-windows) for 90 days. |
| Push to the default branch | The same build also replaces the zip in the **"VeoClone for Windows (latest build)"** pre-release (tag `helper-latest`). The release is updated in place, so the link the user guide gives out never changes, and the old zip stays downloadable until the new one is fully uploaded. **VeoClone Pages** publishes the editor. (On other branches VeoClone Pages shows as skipped.) |
| Tag `veoclone-v...` | **VeoClone Windows** makes a normal, permanent release with the zip, for example "VeoClone v0.2.0". |
| Never by themselves | Reco's own workflows (**Rust CI**, **Release**, **Build Test Binary**, **Test Build (Windows GUI)**). They check and package Reco's own programs, not VeoClone, so in this repository they only run if someone starts them by hand (Actions › choose one › Run workflow). |

To make a permanent release: change `version` in
`crates/veoclone-helper/Cargo.toml` (so `VeoClone.exe --version` matches),
push it to the default branch, then:

```bash
git tag veoclone-v0.2.0
git push origin veoclone-v0.2.0
```

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
  the default branch always finish.
- The release notes name the commit each "latest build" was made from. The
  `helper-latest` tag is moved to that commit too, except when GitHub refuses
  (it can when a workflow file changed in between); the run then shows a
  yellow warning, and the download is fine.
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
