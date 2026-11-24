import { getHarness, isHarness, listHarnesses } from "./registry.js";
import { CURSOR_NOTICE } from "../config/cursor-config.js";
import { COPILOT_NOTICE } from "../config/copilot-config.js";
import { ZED_DONE, ZED_NOTICE } from "../config/zed-config.js";
import type { ConfigurableToolId, DesktopAppId } from "../types.js";

// Desktop apps are configured, never launched, and choose models themselves.
export const DESKTOP_APPS = {
  cursor: {
    id: "cursor",
    label: "Cursor desktop",
    notice: CURSOR_NOTICE,
    done: "Done. Open Cursor and pick a model. Requests go through Cursor's servers.",
    reset: "Removed. Quit and reopen Cursor to see the change.",
  },
  "copilot-app": {
    id: "copilot-app",
    label: "GitHub Copilot app (desktop)",
    notice: COPILOT_NOTICE,
    done: "Done. Open Copilot and pick a model under Concentrate AI.",
    reset: "Removed. Quit and reopen Copilot to see the change.",
  },
  zed: {
    id: "zed",
    label: "Zed",
    notice: ZED_NOTICE,
    done: ZED_DONE,
    reset: "Removed. Zed picks up the change on its own.",
  },
} as const;
export const isDesktopApp = (id: string): id is DesktopAppId =>
  Object.hasOwn(DESKTOP_APPS, id);
export const configurableTool = (id: ConfigurableToolId) =>
  isDesktopApp(id) ? DESKTOP_APPS[id] : getHarness(id);
export const listConfigurableTools = () => [
  ...listHarnesses(),
  ...Object.values(DESKTOP_APPS),
];
export const isConfigurableTool = (id: string): id is ConfigurableToolId =>
  isDesktopApp(id) || isHarness(id);
