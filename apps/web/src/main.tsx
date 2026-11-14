import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import { loadFonts } from "./site/fonts";
import "./site/base.css";
import "./site/app.css";
import "./site/docs.css";
import "./style.css";

loadFonts();
createRoot(document.getElementById("root")!).render(<Root />);
