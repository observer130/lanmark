import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 注意：不用 React.StrictMode——其 dev 双挂载会与 Crepe（Milkdown）的
// 异步 create/destroy 竞争，导致 WYSIWYG 编辑器在 tauri dev 下不可编辑。
// （2026-09-16 验收反馈定位）
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
