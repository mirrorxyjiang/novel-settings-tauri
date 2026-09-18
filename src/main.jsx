import React from "react";
import ReactDOM from "react-dom/client";
import App, { DialogProvider } from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

// DialogProvider 放在最外层：App 自己也要弹确认/输入对话框（删除书籍、模块等）
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
