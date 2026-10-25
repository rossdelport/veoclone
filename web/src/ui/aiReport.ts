// "Save AI report" (DESIGN.md 4.13).
import { api, type ProjectMeta } from "../api";
import { reportFileName } from "./ballWords";
import { button, describeError, toast } from "./common";
import { h } from "./dom";
import { I } from "./icons";

/** "Save AI report": fetches the zip and hands it to the browser as a download. */
export function aiReportButton(p: () => ProjectMeta): HTMLElement {
  const btn = button(
    "Save AI report",
    async () => {
      btn.disabled = true;
      try {
        const blob = await api.aiReport(p().id);
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: reportFileName() });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (e) {
        toast(describeError(e).message, "error", 8000);
      } finally {
        btn.disabled = false;
      }
    },
    { icon: I.download, title: "Save a small file with what the AI saw (no video, no names)" },
  );
  btn.dataset.testid = "ai-report";
  return btn;
}
