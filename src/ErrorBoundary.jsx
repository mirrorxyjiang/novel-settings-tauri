import React from "react";

/**
 * 全局错误边界。
 * 之前遇到的"页面突然全白无响应"，如果是某处渲染代码抛出了未捕获异常，
 * React 会把整棵组件树卸载掉，界面就会变成一片空白且不会自己恢复。
 * 用这个组件包住整个 App，一旦捕获到异常就展示一个可操作的提示页面，
 * 而不是让用户对着空白窗口束手无策；同时把详细错误打到控制台，方便定位问题。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("应用渲染出错：", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "-apple-system, sans-serif",
            color: "#2c2a24",
            background: "#ece5d6",
            padding: 24,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 10 }}>页面出了点问题</div>
          <div style={{ fontSize: 13, color: "#6b6558", marginBottom: 18, maxWidth: 480, lineHeight: 1.7 }}>
            程序遇到了一个未处理的错误而停止渲染。最近一次自动保存的内容不会丢失，
            可以点击下方按钮重新加载界面；如果这个问题反复出现，请把下面这段错误信息，
            连同控制台（右键界面 → 检查元素 → Console 标签）里的完整报错一起发给开发者，方便定位根因。
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 22px",
              borderRadius: 6,
              border: "1px solid #8a5a2b",
              background: "#8a5a2b",
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            重新加载界面
          </button>
          <div style={{ marginTop: 16, fontSize: 11, color: "#a89f8c", maxWidth: 560, wordBreak: "break-all" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
