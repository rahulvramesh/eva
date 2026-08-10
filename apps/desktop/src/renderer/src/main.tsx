import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

document.documentElement.dataset.theme = localStorage.getItem("eva-theme") === "light" ? "light" : "dark";

createRoot(document.getElementById("root")!).render(<App />);
