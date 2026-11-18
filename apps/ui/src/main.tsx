import { createRoot } from "react-dom/client";
import App from "./app.js";
import { applyTheme, loadSettings } from "./util.js";

// 首帧前同步应用主题（避免浅色闪烁）
applyTheme(loadSettings().theme);

createRoot(document.getElementById("app")!).render(<App />);
