// VeoClone editor app: app shell, helper status and hash routing
// (#/, #/new, #/project/:id, #/edit/:id).
import "./styles.css";
import { confirmDialog } from "./ui/common";
import { checkHelper, onHelperState, renderBanner, renderPill } from "./ui/health";
import { editorPage } from "./ui/editor";
import { homePage } from "./ui/home";
import { newMatchPage } from "./ui/newMatch";
import { projectPage } from "./ui/project";
import type { Page, PageContext } from "./ui/page";

// Never run inside another web page's frame, where hidden clicks could delete
// a match (clickjacking). GitHub Pages can't send a header that forbids it.
if (window.top !== window.self) {
  document.body.textContent = "Open VeoClone in its own browser tab.";
  throw new Error("VeoClone was opened inside a frame");
}

const pageHost = document.getElementById("page")!;
const slot = document.getElementById("appbar-slot")!;
const pill = document.getElementById("helper-pill")!;
const banner = document.getElementById("helper-banner")!;

onHelperState((s) => {
  renderPill(pill, s);
  renderBanner(banner, s);
});
void checkHelper();

type Route = [RegExp, (ctx: PageContext, id: string) => Page];
const routes: Route[] = [
  [/^#?\/?$/, (ctx) => homePage(ctx)],
  [/^#\/new\/?$/, (ctx) => newMatchPage(ctx)],
  [/^#\/project\/([A-Za-z0-9_-]+)\/?$/, (ctx, id) => projectPage(ctx, id)],
  [/^#\/edit\/([A-Za-z0-9_-]+)\/?$/, (ctx, id) => editorPage(ctx, id)],
];

let current: Page | null = null;
let currentHash = location.hash;

function render(): void {
  current?.dispose();
  current = null;
  pageHost.replaceChildren();
  slot.replaceChildren();
  document.body.className = "";
  currentHash = location.hash;
  const ctx: PageContext = {
    root: pageHost,
    slot,
    setTitle: (t) => (document.title = t ? `${t} – VeoClone` : "VeoClone"),
  };
  ctx.setTitle("");
  for (const [re, make] of routes) {
    const m = re.exec(location.hash);
    if (m) {
      current = make(ctx, m[1] ?? "");
      window.scrollTo(0, 0);
      return;
    }
  }
  location.replace("#/");
}

window.addEventListener("hashchange", async () => {
  const warning = current?.leaveWarning?.();
  if (warning && location.hash !== currentHash) {
    const target = location.hash;
    history.replaceState(null, "", currentHash || "#/");
    const leave = await confirmDialog({ title: "Leave this page?", text: warning, confirm: "Leave", danger: true });
    if (!leave) return;
    history.replaceState(null, "", target);
  }
  render();
});

window.addEventListener("beforeunload", (e) => {
  if (current?.leaveWarning?.()) e.preventDefault();
});

render();
