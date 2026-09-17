import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  getDataDir, chooseDataDir, listBooks, loadBook, saveBook, deleteBook as deleteBookFile,
  saveAsset, readAsset, deleteAsset,
} from "./store.js";

/**
 * 图片素材内存缓存（模块级单例，随应用重启重置）。
 * 图片内容不再放进 currentBook 这个大对象里参与频繁的状态更新/自动保存，
 * 而是按相对路径懒加载、缓存在这里，避免每次编辑都要重新序列化一份很大的字符串。
 */
const assetCache = new Map(); // relativePath -> dataUrl | null(读取失败)

function useAssetDataUrl(relativePath) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!relativePath) return;
    if (assetCache.has(relativePath)) return;
    let cancelled = false;
    readAsset(relativePath)
      .then((url) => { if (!cancelled) { assetCache.set(relativePath, url); bump((n) => n + 1); } })
      .catch(() => { if (!cancelled) { assetCache.set(relativePath, null); bump((n) => n + 1); } });
    return () => { cancelled = true; };
  }, [relativePath]);
  return relativePath ? assetCache.get(relativePath) : null;
}

/* ============================================================
   小说设定管理工具 —— Tauri 桌面版（本地文件存储）
   书籍 -> 模块（人物关系/地图/大纲/时间线/自定义） -> 页面（绘图区/文字区）
   每本书独立保存为 数据目录/books/{id}.json，方便备份与云盘同步迁移
   ============================================================ */

const uid = () => Math.random().toString(36).slice(2, 10);

const MODULE_PRESETS = [
  { type: "character", name: "人物关系", glyph: "人", tint: "#8a6b3f" },
  { type: "map", name: "地图", glyph: "图", tint: "#3f6b5a" },
  { type: "outline", name: "大纲", glyph: "纲", tint: "#5a5c8a" },
  { type: "timeline", name: "时间线", glyph: "线", tint: "#8a4f4f" },
];

const ICON_LIBRARY = [
  { key: "person", glyph: "◐", label: "人物" },
  { key: "crown", glyph: "♛", label: "王冠" },
  { key: "skull", glyph: "☠", label: "危险" },
  { key: "city", glyph: "▦", label: "城市" },
  { key: "castle", glyph: "♜", label: "城堡" },
  { key: "mountain", glyph: "▲", label: "山脉" },
  { key: "river", glyph: "∿", label: "河流" },
  { key: "forest", glyph: "♣", label: "森林" },
  { key: "flag", glyph: "⚑", label: "标记点" },
  { key: "star", glyph: "★", label: "关键节点" },
  { key: "warn", glyph: "!", label: "冲突" },
  { key: "question", glyph: "?", label: "悬念" },
  { key: "lock", glyph: "◈", label: "锁/秘密" },
  { key: "key", glyph: "⚿", label: "钥匙" },
  { key: "chest", glyph: "▣", label: "宝箱" },
  { key: "heart", glyph: "♥", label: "情感" },
];

function newBook(name) {
  const now = Date.now();
  return {
    id: uid(),
    name: name || "未命名书籍",
    createdAt: now,
    updatedAt: now,
    modules: MODULE_PRESETS.map((m) => ({
      id: uid(),
      name: m.name,
      type: m.type,
      tint: m.tint,
      pages: [],
    })),
  };
}

function newPage(name, pageType) {
  return {
    id: uid(),
    name: name || (pageType === "draw" ? "新绘图页" : "新文字页"),
    pageType, // 'draw' | 'text'
    content: pageType === "draw" ? { elements: [] } : { html: "" },
    children: [], // 子页面（同样是 draw/text 页面的数组），支持任意层级嵌套
  };
}

/* ------------------------------------------------------------
   页面树的一组纯函数工具。
   模块下的 pages 现在允许每个页面再挂子页面（page.children），
   所以"按 id 查找/修改/删除某个页面"不能再用简单的数组 .find/.map，
   要递归地在整棵树里找。
   ------------------------------------------------------------ */

// 递归查找某个 id 对应的页面节点
function findPageInTree(pages, id) {
  for (const p of pages) {
    if (p.id === id) return p;
    if (p.children && p.children.length) {
      const found = findPageInTree(p.children, id);
      if (found) return found;
    }
  }
  return null;
}

// 递归地对某个 id 对应的页面节点做变换（其余节点原样返回）
function mapPageInTree(pages, id, fn) {
  return pages.map((p) => {
    if (p.id === id) return fn(p);
    if (p.children && p.children.length) return { ...p, children: mapPageInTree(p.children, id, fn) };
    return p;
  });
}

// 递归地在某个父页面节点下追加一个子页面
function addChildPageInTree(pages, parentId, child) {
  return pages.map((p) => {
    if (p.id === parentId) return { ...p, children: [...(p.children || []), child] };
    if (p.children && p.children.length) return { ...p, children: addChildPageInTree(p.children, parentId, child) };
    return p;
  });
}

// 递归地删除某个 id 对应的页面节点（连同其子页面一起）
function removePageInTree(pages, id) {
  return pages
    .filter((p) => p.id !== id)
    .map((p) => (p.children && p.children.length ? { ...p, children: removePageInTree(p.children, id) } : p));
}

function defaultShapeStyle() {
  return { stroke: "#33302a", strokeWidth: 2, strokeStyle: "solid", fill: "#c9b98a", fillOpacity: 0.25 };
}

/* ============================================================ */

export default function App() {
  const [dataDir, setDataDir] = useState("");
  const [bookIndex, setBookIndex] = useState(null); // null = 加载中
  const [currentBook, setCurrentBook] = useState(null);
  const [currentModuleId, setCurrentModuleId] = useState(null);
  const [currentPageId, setCurrentPageId] = useState(null);
  const [toast, setToast] = useState("");
  const [opening, setOpening] = useState(false);

  const flashToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const refreshIndex = useCallback(async () => {
    try {
      const list = await listBooks();
      setBookIndex(list);
    } catch (e) {
      flashToast("读取书籍列表失败：" + String(e));
      setBookIndex([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setDataDir(await getDataDir());
      } catch (e) {
        flashToast("获取存储目录失败：" + String(e));
      }
      await refreshIndex();
    })();
  }, [refreshIndex]);

  // 自动保存：内容变化后 500ms 无新变化才写盘，避免频繁写文件
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!currentBook) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const toSave = { ...currentBook, updatedAt: Date.now() };
        await saveBook(toSave);
      } catch (e) {
        flashToast("保存失败：" + String(e));
      }
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [currentBook]);

  const updateCurrentPage = useCallback(
    (fn, opts) => {
      if (!currentModuleId || !currentPageId) return;
      setCurrentBook((prev) => {
        if (!prev) return prev;
        const updated = {
          ...prev,
          modules: prev.modules.map((m) =>
            m.id !== currentModuleId ? m : { ...m, pages: mapPageInTree(m.pages, currentPageId, fn) }
          ),
        };
        // 手动点击"立即保存"时，跳过 500ms 防抖，直接落盘并给一个成功提示
        if (opts?.immediate) {
          const toSave = { ...updated, updatedAt: Date.now() };
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveBook(toSave)
            .then(() => flashToast("已保存"))
            .catch((e) => flashToast("保存失败：" + String(e)));
          return toSave;
        }
        return updated;
      });
    },
    [currentModuleId, currentPageId]
  );

  const openBook = async (id) => {
    setOpening(true);
    try {
      const book = await loadBook(id);
      setCurrentBook(book);
      setCurrentModuleId(null);
      setCurrentPageId(null);
    } catch (e) {
      flashToast("打开书籍失败：" + String(e));
    } finally {
      setOpening(false);
    }
  };

  const closeBook = async () => {
    if (currentBook) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try {
        await saveBook({ ...currentBook, updatedAt: Date.now() });
      } catch (e) {
        flashToast("保存失败：" + String(e));
      }
    }
    setCurrentBook(null);
    setCurrentModuleId(null);
    setCurrentPageId(null);
    refreshIndex();
  };

  const createBook = async (name) => {
    const b = newBook(name);
    try {
      await saveBook(b);
      setCurrentBook(b);
      refreshIndex();
    } catch (e) {
      flashToast("创建书籍失败：" + String(e));
    }
  };

  const removeBook = async (id) => {
    try {
      await deleteBookFile(id);
      refreshIndex();
    } catch (e) {
      flashToast("删除失败：" + String(e));
    }
  };

  // 书籍重命名：如果这本书当前正打开着，直接改内存里的状态（会走正常的自动保存流程）；
  // 如果是在书库首页对着一本没打开的书改名，则读一下文件、改名字、立刻存回去。
  const renameBook = async (id, name) => {
    try {
      if (currentBook && currentBook.id === id) {
        setCurrentBook((b) => ({ ...b, name }));
      } else {
        const book = await loadBook(id);
        book.name = name;
        book.updatedAt = Date.now();
        await saveBook(book);
      }
      refreshIndex();
    } catch (e) {
      flashToast("重命名失败：" + String(e));
    }
  };

  const handleChooseDataDir = async () => {
    try {
      const path = await chooseDataDir();
      if (path) {
        setDataDir(path);
        flashToast("存储位置已更新，建议将该文件夹放在云盘同步目录中以便跨设备迁移");
        refreshIndex();
      }
    } catch (e) {
      flashToast("选择目录失败：" + String(e));
    }
  };

  if (bookIndex === null || opening) {
    return <Shell><div className="loading">{opening ? "正在打开书籍…" : "正在载入设定库…"}</div></Shell>;
  }

  if (!currentBook) {
    return (
      <Shell>
        <BookLibrary
          books={bookIndex}
          dataDir={dataDir}
          onChooseDataDir={handleChooseDataDir}
          onOpen={openBook}
          onCreate={createBook}
          onDelete={removeBook}
          onRename={renameBook}
        />
        {toast && <div className="toast">{toast}</div>}
      </Shell>
    );
  }

  const currentModule = currentBook.modules.find((m) => m.id === currentModuleId) || null;
  const currentPage = currentModule ? findPageInTree(currentModule.pages, currentPageId) : null;

  return (
    <Shell>
      <div className="workspace">
        <Sidebar
          book={currentBook}
          currentModuleId={currentModuleId}
          currentPageId={currentPageId}
          onBack={closeBook}
          onRenameBook={(name) => setCurrentBook((b) => ({ ...b, name }))}
          onSelectPage={(mid, pid) => { setCurrentModuleId(mid); setCurrentPageId(pid); }}
          onAddModule={() => {
            setCurrentBook((b) => ({
              ...b,
              modules: [...b.modules, { id: uid(), name: "新模块", type: "custom", tint: "#6b6558", pages: [] }],
            }));
          }}
          onRenameModule={(mid, name) => {
            setCurrentBook((b) => ({ ...b, modules: b.modules.map((m) => (m.id === mid ? { ...m, name } : m)) }));
          }}
          onAddPage={(mid, pageType, name) => {
            const p = newPage(name, pageType);
            setCurrentBook((b) => ({
              ...b,
              modules: b.modules.map((m) => (m.id === mid ? { ...m, pages: [...m.pages, p] } : m)),
            }));
            setCurrentModuleId(mid);
            setCurrentPageId(p.id);
          }}
          onAddSubPage={(mid, parentPageId, pageType, name) => {
            const p = newPage(name, pageType);
            setCurrentBook((b) => ({
              ...b,
              modules: b.modules.map((m) => (m.id === mid ? { ...m, pages: addChildPageInTree(m.pages, parentPageId, p) } : m)),
            }));
            setCurrentModuleId(mid);
            setCurrentPageId(p.id);
          }}
          onRenamePage={(mid, pid, name) => {
            setCurrentBook((b) => ({
              ...b,
              modules: b.modules.map((m) => (m.id !== mid ? m : { ...m, pages: mapPageInTree(m.pages, pid, (p) => ({ ...p, name })) })),
            }));
          }}
          onDeletePage={(mid, pid) => {
            setCurrentBook((b) => ({
              ...b,
              modules: b.modules.map((m) => (m.id !== mid ? m : { ...m, pages: removePageInTree(m.pages, pid) })),
            }));
            if (currentPageId === pid) setCurrentPageId(null);
          }}
        />
        <main className="main-area">
          {!currentPage ? (
            <EmptyState moduleName={currentModule?.name} />
          ) : currentPage.pageType === "draw" ? (
            <DrawPage page={currentPage} onChange={updateCurrentPage} bookId={currentBook.id} onError={flashToast} />
          ) : (
            <TextPage page={currentPage} onChange={updateCurrentPage} />
          )}
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </Shell>
  );
}

/* ============================================================ Shell / 样式 */

function Shell({ children }) {
  return (
    <div className="app-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        :root {
          --paper: #ece5d6; --paper-deep: #ddd3bd; --ink: #2c2a24; --ink-soft: #6b6558;
          --line: #c9bda1; --accent: #8a5a2b; --accent-soft: #cfa768; --danger: #9a4a3d; --panel: #f4efe3;
        }
        .app-root { font-family: 'Inter', -apple-system, sans-serif; color: var(--ink); background: var(--paper);
          width: 100%; height: 100vh; min-height: 640px; display: flex; flex-direction: column; overflow: hidden; }
        .loading { margin: auto; color: var(--ink-soft); font-size: 14px; }
        .workspace { display: flex; flex: 1; min-height: 0; }
        .sidebar { width: 248px; flex-shrink: 0; background: var(--paper-deep); border-right: 1px solid var(--line);
          display: flex; flex-direction: column; overflow-y: auto; }
        .sidebar-header { padding: 16px 16px 12px; border-bottom: 1px solid var(--line); }
        .sidebar-back { background: none; border: none; cursor: pointer; color: var(--ink-soft); font-size: 12px;
          padding: 0 0 8px; display: flex; align-items: center; gap: 4px; }
        .sidebar-back:hover { color: var(--accent); }
        .sidebar-booktitle-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
        .sidebar-booktitle { font-family: 'Noto Serif SC', serif; font-weight: 700; font-size: 17px; line-height: 1.3; }
        .icon-action { border: none; background: none; cursor: pointer; color: var(--ink-soft); font-size: 12px; padding: 2px 4px; border-radius: 4px; flex-shrink: 0; }
        .icon-action:hover { color: var(--accent); background: rgba(0,0,0,0.05); }
        .icon-action.danger:hover { color: var(--danger); }
        .module-block { border-bottom: 1px solid var(--line); }
        .module-title { display: flex; align-items: center; gap: 8px; padding: 10px 16px; cursor: pointer; font-size: 13px; font-weight: 600; }
        .module-badge { width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center;
          font-family: 'Noto Serif SC', serif; font-size: 12px; color: #fff; flex-shrink: 0; }
        .module-title input { background: transparent; border: none; font-weight: 600; font-size: 13px; color: var(--ink); width: 100%; font-family: inherit; }
        .page-list { padding-bottom: 6px; }
        .page-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 16px 6px 44px;
          font-size: 12.5px; cursor: pointer; color: var(--ink-soft); gap: 6px; }
        .page-item.active { background: var(--panel); color: var(--accent); font-weight: 600; }
        .page-item:hover { background: rgba(255,255,255,0.4); }
        .page-item .type-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
        .page-item .page-caret { width: 14px; flex-shrink: 0; font-size: 13px; color: var(--ink-soft); cursor: pointer; text-align: center; }
        .page-item .page-caret:hover { color: var(--accent); }
        .page-item .p-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .page-item .page-action-btn { opacity: 0.45; border: none; background: none; cursor: pointer; color: var(--ink-soft);
          font-size: 15px; line-height: 1; padding: 3px 5px; border-radius: 4px; flex-shrink: 0; }
        .page-item:hover .page-action-btn { opacity: 0.9; }
        .page-action-btn:hover { opacity: 1 !important; background: rgba(0,0,0,0.06); color: var(--accent); }
        .page-action-btn.open { opacity: 1; background: rgba(0,0,0,0.06); color: var(--accent); }
        .page-action-btn.danger:hover { color: var(--danger); }
        .add-sub-menu { display: flex; gap: 6px; padding: 4px 16px 8px; }
        .add-sub-menu button { font-size: 11.5px; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
          padding: 4px 10px; border-radius: 12px; cursor: pointer; }
        .add-sub-menu button:hover { border-color: var(--accent); color: var(--accent); }
        .add-page-row { padding: 4px 16px 10px 44px; display: flex; gap: 6px; }
        .add-page-row button { font-size: 11px; border: 1px dashed var(--line); background: none; color: var(--ink-soft);
          padding: 3px 8px; border-radius: 4px; cursor: pointer; }
        .add-page-row button:hover { border-color: var(--accent); color: var(--accent); }
        .add-module-btn { margin: 10px 16px; padding: 8px; border: 1px dashed var(--line); background: none;
          border-radius: 6px; cursor: pointer; font-size: 12.5px; color: var(--ink-soft); }
        .add-module-btn:hover { border-color: var(--accent); color: var(--accent); }
        .main-area { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--paper); }
        .empty-state { margin: auto; text-align: center; color: var(--ink-soft); font-size: 13.5px; }
        .empty-state .big { font-family: 'Noto Serif SC', serif; font-size: 20px; color: var(--ink); margin-bottom: 6px; }
        .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--ink);
          color: var(--paper); padding: 8px 16px; border-radius: 6px; font-size: 12.5px; max-width: 70%; text-align: center; }
        .library { margin: auto; width: 100%; max-width: 880px; padding: 48px 32px; overflow-y: auto; max-height: 100%; }
        .library h1 { font-family: 'Noto Serif SC', serif; font-size: 30px; margin: 0 0 6px; }
        .library .sub { color: var(--ink-soft); font-size: 13.5px; margin-bottom: 10px; }
        .storage-row { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; font-size: 12px;
          color: var(--ink-soft); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; }
        .storage-row .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; }
        .storage-row button { border: 1px solid var(--line); background: var(--paper); border-radius: 4px; padding: 4px 10px;
          cursor: pointer; font-size: 11.5px; color: var(--ink); flex-shrink: 0; }
        .storage-row button:hover { border-color: var(--accent); color: var(--accent); }
        .book-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
        .book-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px 16px;
          cursor: pointer; position: relative; transition: border-color .15s; }
        .book-card:hover { border-color: var(--accent); }
        .book-card .spine { width: 30px; height: 4px; background: var(--accent-soft); border-radius: 2px; margin-bottom: 14px; }
        .book-card h3 { font-family: 'Noto Serif SC', serif; font-size: 16px; margin: 0 0 4px; }
        .book-card .meta { font-size: 11px; color: var(--ink-soft); }
        .book-card .card-actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 2px; opacity: 0; }
        .book-card:hover .card-actions { opacity: 1; }
        .new-book-card { border: 1px dashed var(--line); border-radius: 8px; display: flex; align-items: center;
          justify-content: center; cursor: pointer; min-height: 96px; color: var(--ink-soft); font-size: 13px; flex-direction: column; gap: 6px; }
        .new-book-card:hover { border-color: var(--accent); color: var(--accent); }
        .new-book-card .plus { font-size: 22px; }
        .text-page { display: flex; flex-direction: column; height: 100%; }
        .page-topbar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
        .page-topbar input.page-name { font-family: 'Noto Serif SC', serif; font-size: 16px; font-weight: 700; border: none; background: transparent; color: var(--ink); flex: 1; }
        .page-topbar .tag { font-size: 11px; color: #fff; background: var(--accent-soft); padding: 2px 8px; border-radius: 10px; }
        .manual-save-btn { font-size: 11.5px; border: 1px solid var(--line); background: var(--paper); color: var(--ink);
          padding: 5px 10px; border-radius: 5px; cursor: pointer; flex-shrink: 0; }
        .manual-save-btn:hover { border-color: var(--accent); color: var(--accent); }
        .text-toolbar { display: flex; gap: 4px; padding: 8px 20px; border-bottom: 1px solid var(--line); background: var(--paper); }
        .text-toolbar button { width: 28px; height: 28px; border: 1px solid var(--line); background: var(--panel); border-radius: 4px; cursor: pointer; font-size: 13px; color: var(--ink); }
        .text-toolbar button:hover { border-color: var(--accent); }
        .text-editor { flex: 1; padding: 28px 40px; overflow-y: auto; outline: none; font-size: 14.5px; line-height: 1.9; max-width: 780px; }
        .text-editor:empty:before { content: attr(data-placeholder); color: #a89f8c; }
        .draw-page { display: flex; flex-direction: column; height: 100%; }
        .draw-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
        .tool-btn { border: 1px solid var(--line); background: var(--paper); border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--ink); display: flex; align-items: center; gap: 4px; }
        .tool-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
        .tool-btn:hover:not(.active) { border-color: var(--accent-soft); }
        .toolbar-sep { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }
        .icon-tray { display: flex; gap: 3px; flex-wrap: wrap; max-width: 320px; }
        .icon-chip { width: 26px; height: 26px; border-radius: 5px; border: 1px solid var(--line); background: var(--paper); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px; }
        .icon-chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
        .icon-chip:hover:not(.active) { border-color: var(--accent-soft); }
        .draw-body { flex: 1; display: flex; min-height: 0; }
        .canvas-wrap { flex: 1; overflow: auto; background: linear-gradient(90deg, rgba(0,0,0,0.035) 1px, transparent 1px) 0 0/24px 24px, linear-gradient(rgba(0,0,0,0.035) 1px, transparent 1px) 0 0/24px 24px, var(--paper); }
        .canvas-scale { position: relative; }
        .canvas-svg { display: block; cursor: crosshair; }
        .canvas-svg.select-mode { cursor: default; }
        .canvas-svg.pan-mode { cursor: grab; }
        .canvas-svg.pan-mode:active { cursor: grabbing; }
        .zoom-controls { display: flex; align-items: center; gap: 2px; margin-left: auto; }
        .zoom-btn { padding: 6px 10px; font-weight: 600; }
        .zoom-readout { min-width: 52px; justify-content: center; font-variant-numeric: tabular-nums; }
        .style-panel { width: 236px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--panel); padding: 16px; overflow-y: auto; font-size: 12.5px; }
        .style-panel h4 { font-family: 'Noto Serif SC', serif; font-size: 13.5px; margin: 0 0 12px; }
        .field { margin-bottom: 14px; }
        .field label { display: block; margin-bottom: 5px; color: var(--ink-soft); font-size: 11.5px; }
        .field input[type=color] { width: 100%; height: 26px; border: 1px solid var(--line); border-radius: 4px; padding: 2px; }
        .field input[type=range] { width: 100%; }
        .field input[type=text], .field textarea { width: 100%; border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; font-family: inherit; font-size: 12.5px; background: #fff; }
        .field textarea { resize: vertical; min-height: 70px; }
        .seg { display: flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
        .seg button { flex: 1; border: none; background: #fff; padding: 5px 0; font-size: 11.5px; cursor: pointer; }
        .seg button.on { background: var(--accent); color: #fff; }
        .delete-el-btn { width: 100%; padding: 7px 0; border: 1px solid var(--danger); color: var(--danger); background: none; border-radius: 5px; cursor: pointer; font-size: 12px; margin-top: 6px; }
        .delete-el-btn:hover { background: var(--danger); color: #fff; }
        .panel-empty { color: var(--ink-soft); text-align: center; padding: 30px 0; font-size: 12px; }
      `}</style>
      {children}
    </div>
  );
}

/* ============================================================ 书库首页 */

function BookLibrary({ books, dataDir, onChooseDataDir, onOpen, onCreate, onDelete, onRename }) {
  return (
    <div className="library">
      <h1>设定库</h1>
      <div className="sub">选择一本书继续创作，或新建一本书开始整理设定。</div>
      <div className="storage-row">
        <span>当前存储位置：</span>
        <span className="path" title={dataDir}>{dataDir || "读取中…"}</span>
        <button onClick={onChooseDataDir}>更改存储位置…</button>
      </div>
      <div className="book-grid">
        {books.map((b) => (
          <div className="book-card" key={b.id} onClick={() => onOpen(b.id)}>
            <div className="card-actions">
              <button
                className="icon-action"
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation();
                  const name = prompt("书籍名称：", b.name);
                  if (name && name.trim()) onRename(b.id, name.trim());
                }}
              >✎</button>
              <button
                className="icon-action danger"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`确定删除《${b.name}》吗？文件会被移到回收目录，可从磁盘手动恢复。`)) onDelete(b.id);
                }}
              >✕</button>
            </div>
            <div className="spine" />
            <h3>{b.name}</h3>
            <div className="meta">{b.page_count} 个页面 · {new Date(b.updated_at || Date.now()).toLocaleDateString()}</div>
          </div>
        ))}
        <div
          className="new-book-card"
          onClick={() => {
            const name = prompt("书籍名称：", "未命名书籍");
            if (name && name.trim()) onCreate(name.trim());
          }}
        >
          <div className="plus">＋</div>
          <div>新建书籍</div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ 侧边栏 */

function Sidebar({
  book, currentModuleId, currentPageId, onBack, onRenameBook,
  onSelectPage, onAddModule, onRenameModule, onAddPage, onAddSubPage, onRenamePage, onDeletePage,
}) {
  const [openModules, setOpenModules] = useState(() => new Set(book.modules.map((m) => m.id)));
  const [collapsedPages, setCollapsedPages] = useState(() => new Set());
  const toggle = (id) => {
    setOpenModules((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const togglePage = (id) => {
    setCollapsedPages((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="sidebar-back" onClick={onBack}>← 返回设定库</button>
        <div className="sidebar-booktitle-row">
          <div className="sidebar-booktitle">{book.name}</div>
          <button
            className="icon-action"
            title="重命名书籍"
            onClick={() => {
              const name = prompt("书籍名称：", book.name);
              if (name && name.trim()) onRenameBook(name.trim());
            }}
          >✎</button>
        </div>
      </div>
      {book.modules.map((m) => {
        const preset = MODULE_PRESETS.find((p) => p.type === m.type);
        const glyph = preset ? preset.glyph : "自";
        const open = openModules.has(m.id);
        return (
          <div className="module-block" key={m.id}>
            <div className="module-title" onClick={() => toggle(m.id)}>
              <div className="module-badge" style={{ background: m.tint }}>{glyph}</div>
              <input value={m.name} onClick={(e) => e.stopPropagation()} onChange={(e) => onRenameModule(m.id, e.target.value)} />
              <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
            </div>
            {open && (
              <>
                <div className="page-list">
                  {m.pages.map((p) => (
                    <PageNode
                      key={p.id}
                      moduleId={m.id}
                      page={p}
                      depth={0}
                      currentPageId={currentPageId}
                      collapsedPages={collapsedPages}
                      onTogglePage={togglePage}
                      onSelectPage={onSelectPage}
                      onRenamePage={onRenamePage}
                      onAddSubPage={onAddSubPage}
                      onDeletePage={onDeletePage}
                    />
                  ))}
                </div>
                <div className="add-page-row">
                  <button onClick={() => onAddPage(m.id, "text", prompt("文字页名称：", "新文字页") || "新文字页")}>+ 文字区</button>
                  <button onClick={() => onAddPage(m.id, "draw", prompt("绘图页名称：", "新绘图页") || "新绘图页")}>+ 绘图区</button>
                </div>
              </>
            )}
          </div>
        );
      })}
      <button className="add-module-btn" onClick={onAddModule}>+ 新建自定义模块</button>
    </div>
  );
}

// 页面树的单个节点：自己 + 递归渲染子页面。缩进按层级递增，用来体现"页面下的子页面"这种嵌套关系。
function PageNode({ moduleId, page, depth, currentPageId, collapsedPages, onTogglePage, onSelectPage, onRenamePage, onAddSubPage, onDeletePage }) {
  const hasChildren = page.children && page.children.length > 0;
  const collapsed = collapsedPages.has(page.id);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const rowRef = useRef(null);

  // 点击行外任意地方，自动收起"添加子页面"的类型选择小菜单
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDocClick = (e) => { if (rowRef.current && !rowRef.current.contains(e.target)) setAddMenuOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [addMenuOpen]);

  const addSub = (type) => {
    setAddMenuOpen(false);
    const name = prompt("子页面名称：", type === "draw" ? "新绘图页" : "新文字页");
    if (name && name.trim()) onAddSubPage(moduleId, page.id, type, name.trim());
  };

  return (
    <>
      <div ref={rowRef} className="page-node">
        <div
          className={"page-item" + (page.id === currentPageId ? " active" : "")}
          style={{ paddingLeft: 44 + depth * 16 }}
          onClick={() => onSelectPage(moduleId, page.id)}
        >
          {hasChildren ? (
            <span className="page-caret" onClick={(e) => { e.stopPropagation(); onTogglePage(page.id); }}>{collapsed ? "▸" : "▾"}</span>
          ) : (
            <span className="type-dot" style={{ background: page.pageType === "draw" ? "#8a5a2b" : "#5a6b8a" }} />
          )}
          <span
            className="p-name"
            onDoubleClick={(e) => {
              e.stopPropagation();
              const name = prompt("重命名页面：", page.name);
              if (name && name.trim()) onRenamePage(moduleId, page.id, name.trim());
            }}
            title="双击重命名"
          >{page.name}</span>
          <button
            className={"page-action-btn" + (addMenuOpen ? " open" : "")}
            title="添加子页面"
            onClick={(e) => { e.stopPropagation(); setAddMenuOpen((v) => !v); }}
          >＋</button>
          <button
            className="page-action-btn danger"
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              const msg = hasChildren ? `删除页面「${page.name}」？其下的子页面会一并删除。` : `删除页面「${page.name}」？`;
              if (confirm(msg)) onDeletePage(moduleId, page.id);
            }}
          >✕</button>
        </div>
        {addMenuOpen && (
          <div className="add-sub-menu" style={{ marginLeft: 44 + depth * 16 }}>
            <button onClick={() => addSub("text")}>📝 文字子页</button>
            <button onClick={() => addSub("draw")}>🖌 绘图子页</button>
          </div>
        )}
      </div>
      {hasChildren && !collapsed && page.children.map((child) => (
        <PageNode
          key={child.id}
          moduleId={moduleId}
          page={child}
          depth={depth + 1}
          currentPageId={currentPageId}
          collapsedPages={collapsedPages}
          onTogglePage={onTogglePage}
          onSelectPage={onSelectPage}
          onRenamePage={onRenamePage}
          onAddSubPage={onAddSubPage}
          onDeletePage={onDeletePage}
        />
      ))}
    </>
  );
}

function EmptyState({ moduleName }) {
  return (
    <div className="empty-state">
      <div className="big">{moduleName ? `${moduleName} · 未选择页面` : "从左侧选择或新建一个页面"}</div>
      <div>每个模块可以包含任意数量的绘图页与文字页，页面下还能再挂子页面</div>
    </div>
  );
}

/* ============================================================ 文字区 */

function TextPage({ page, onChange }) {
  const ref = useRef(null);
  const [name, setName] = useState(page.name);
  const typingTimer = useRef(null);

  useEffect(() => setName(page.name), [page.id]);
  useEffect(() => {
    // 用 try/catch 包一层：这里是直接操作 DOM，理论上已经做了空值判断，
    // 但为了不让任何一次意外的 DOM 异常把整个应用炸掉（之前遇到的白屏问题），加一道保险，
    // 出错也只是这次没同步成功，不会导致渲染中断。
    try {
      const node = ref.current;
      if (node && node.innerHTML !== (page.content.html || "")) node.innerHTML = page.content.html || "";
    } catch (err) {
      console.error("同步文字内容到编辑器失败：", err);
    }
  }, [page.id]);
  useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current); }, [page.id]);

  const exec = (cmd, value) => {
    try {
      ref.current?.focus();
      document.execCommand(cmd, false, value ?? null);
    } catch (err) {
      console.error("执行编辑命令失败：", err);
    }
  };

  const readHtml = (fallbackNode) => {
    try {
      const node = ref.current || fallbackNode || null;
      return node ? node.innerHTML : "";
    } catch (err) {
      console.error("读取文字内容失败：", err);
      return "";
    }
  };

  // 输入停顿 1 秒后自动把内容同步进应用状态（进而触发自动保存），
  // 这样即使长时间连续打字不失焦，内容也会被周期性保存，不用非得点开别的地方才存。
  const handleInput = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      onChange((p) => ({ ...p, content: { html: readHtml() } }));
    }, 1000);
  };

  const handleManualSave = () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    onChange((p) => ({ ...p, content: { html: readHtml() } }), { immediate: true });
  };

  return (
    <div className="text-page">
      <div className="page-topbar">
        <input className="page-name" value={name} onChange={(e) => { setName(e.target.value); onChange((p) => ({ ...p, name: e.target.value })); }} />
        <button className="manual-save-btn" onClick={handleManualSave}>💾 立即保存</button>
        <span className="tag">文字区</span>
      </div>
      <div className="text-toolbar">
        <button onClick={() => exec("bold")}><b>B</b></button>
        <button onClick={() => exec("italic")}><i>I</i></button>
        <button onClick={() => exec("underline")}><u>U</u></button>
        <button onClick={() => exec("insertUnorderedList")}>•≡</button>
        <button onClick={() => exec("insertOrderedList")}>1≡</button>
        <button onMouseDown={(e) => { e.preventDefault(); exec("formatBlock", "H3"); }}>H</button>
      </div>
      <div
        ref={ref} className="text-editor" contentEditable suppressContentEditableWarning
        data-placeholder="在这里记录设定内容…支持加粗、列表、标题"
        onInput={handleInput}
        onBlur={(e) => {
          if (typingTimer.current) clearTimeout(typingTimer.current);
          onChange((p) => ({ ...p, content: { html: readHtml(e.currentTarget) } }), { immediate: true });
        }}
      />
    </div>
  );
}

/* ============================================================ 绘图区 */

const TOOLS = [
  { key: "select", label: "选择", glyph: "↖" },
  { key: "pan", label: "抓手", glyph: "✋" },
  { key: "rect", label: "矩形", glyph: "▭" },
  { key: "ellipse", label: "圆形", glyph: "◯" },
  { key: "line", label: "直线", glyph: "／" },
  { key: "arrow", label: "箭头", glyph: "→" },
  { key: "text", label: "文本", glyph: "T" },
];

function DrawPage({ page, onChange, bookId, onError }) {
  const [name, setName] = useState(page.name);
  const [tool, setTool] = useState("select");
  const [pickedIcon, setPickedIcon] = useState("person");
  const [selectedId, setSelectedId] = useState(null);
  const [bgSelected, setBgSelected] = useState(false);
  const [draft, setDraft] = useState(null);
  const [zoom, setZoom] = useState(1); // 画布缩放比例，1 = 100%
  const [spacePanning, setSpacePanning] = useState(false); // 按住空格键临时切到抓手模式
  const svgRef = useRef(null);
  const wrapRef = useRef(null); // 画布外层可滚动容器，抓手拖动时直接改它的 scrollLeft/scrollTop
  const dragRef = useRef(null);
  const bgDragRef = useRef(null); // 背景图的拖动/缩放状态：{ mode: 'move'|'resize', ... }
  const panRef = useRef(null); // 抓手拖动状态：{ startX, startY, scrollLeft, scrollTop }

  useEffect(() => setName(page.name), [page.id]);
  useEffect(() => { setSelectedId(null); setBgSelected(false); setZoom(1); }, [page.id]);

  // 空格键按住时临时切换成抓手模式（松开恢复原工具），是图形软件里很常见的交互习惯。
  // 只在没有正在编辑文本输入框时响应，避免打字打到一半space被吞掉。
  useEffect(() => {
    const isTypingTarget = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    const onKeyDown = (e) => { if (e.code === "Space" && !e.repeat && !isTypingTarget(document.activeElement)) { e.preventDefault(); setSpacePanning(true); } };
    const onKeyUp = (e) => { if (e.code === "Space") setSpacePanning(false); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  // 抓手拖动本身直接操作滚动容器的 scrollLeft/scrollTop，挂在 window 上监听，
  // 这样即使拖动过程中鼠标短暂移出画布区域也不会中断。
  useEffect(() => {
    const onMove = (e) => {
      if (!panRef.current || !wrapRef.current) return;
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      wrapRef.current.scrollLeft = panRef.current.scrollLeft - dx;
      wrapRef.current.scrollTop = panRef.current.scrollTop - dy;
    };
    const onUp = () => { panRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const isPanMode = tool === "pan" || spacePanning;
  const startPan = (e) => {
    if (!wrapRef.current) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, scrollLeft: wrapRef.current.scrollLeft, scrollTop: wrapRef.current.scrollTop };
  };

  // 兜底：如果鼠标在画布外松开导致 svg 自身的 mouseup/mouseleave 没能触发，
  // 这里用一个全局监听把可能卡住的拖动状态清掉，避免后续鼠标移动仍按旧的拖动状态计算坐标而出错。
  useEffect(() => {
    const clearStuckDrags = () => { dragRef.current = null; bgDragRef.current = null; };
    window.addEventListener("mouseup", clearStuckDrags);
    return () => window.removeEventListener("mouseup", clearStuckDrags);
  }, []);

  const elements = page.content.elements;
  const background = page.content.background || null;
  const selected = elements.find((el) => el.id === selectedId) || null;
  const setElements = (fn) => onChange((p) => ({ ...p, content: { ...p.content, elements: fn(p.content.elements) } }));
  const setBackground = (patchOrNull) => {
    onChange((p) => ({
      ...p,
      content: {
        ...p.content,
        background: patchOrNull === null ? null : { ...(p.content.background || {}), ...patchOrNull },
      },
    }));
  };

  const clampZoom = (z) => Math.min(3, Math.max(0.25, z));
  const zoomIn = () => setZoom((z) => Math.round(clampZoom(z + 0.1) * 100) / 100);
  const zoomOut = () => setZoom((z) => Math.round(clampZoom(z - 0.1) * 100) / 100);
  const zoomReset = () => setZoom(1);

  // 按住 Ctrl/Cmd 滚轮缩放画布，不按修饰键时保持普通滚动，避免和日常滚动画布冲突
  const handleWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.round(clampZoom(z - e.deltaY * 0.001) * 100) / 100);
  };

  // 加了空值保护：极端情况下（比如页面切换的瞬间）svgRef.current 可能还没挂载好，
  // 直接调用 .getBoundingClientRect() 会抛出异常导致整个界面白屏，这里做兜底返回一个默认值。
  // 画布被 CSS 缩放后，getBoundingClientRect() 返回的是缩放后的屏幕尺寸，
  // 所以要把鼠标坐标按当前缩放比例换算回画布自身的逻辑坐标，否则缩放后绘图/拖拽位置会完全对不上。
  const svgPoint = (e) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const handleCanvasDown = (e) => {
    if (tool === "select" || isPanMode) return;
    const { x, y } = svgPoint(e);
    if (tool === "text") {
      const el = { id: uid(), type: "text", x, y, text: "文本", note: "", color: "#33302a", bold: false };
      setElements((els) => [...els, el]);
      setTool("select"); setSelectedId(el.id);
      return;
    }
    setDraft({ type: tool, x1: x, y1: y, x2: x, y2: y, ...defaultShapeStyle() });
  };

  const handleCanvasMove = (e) => {
    if (draft) { const { x, y } = svgPoint(e); setDraft((d) => ({ ...d, x2: x, y2: y })); }

    const drag = dragRef.current;
    if (drag) {
      const { x, y } = svgPoint(e);
      setElements((els) => els.map((el) => {
        if (el.id !== drag.id) return el;
        if (el.type === "line" || el.type === "arrow") {
          if (drag.endpoint === "1") return { ...el, x1: x, y1: y };
          if (drag.endpoint === "2") return { ...el, x2: x, y2: y };
          return { ...el, x1: x - drag.offsetX, y1: y - drag.offsetY, x2: x - drag.offsetX + drag.dx, y2: y - drag.offsetY + drag.dy };
        }
        return { ...el, x: x - drag.offsetX, y: y - drag.offsetY };
      }));
    }

    const bgDrag = bgDragRef.current;
    if (bgDrag && background) {
      const { x, y } = svgPoint(e);
      if (bgDrag.mode === "move") {
        setBackground({ x: x - bgDrag.offsetX, y: y - bgDrag.offsetY });
      } else if (bgDrag.mode === "resize") {
        const w = Math.max(30, bgDrag.startW + (x - bgDrag.startX));
        const h = Math.max(30, bgDrag.startH + (y - bgDrag.startY));
        setBackground({ w, h });
      }
    }
  };

  const handleCanvasUp = () => {
    if (draft) {
      const w = Math.abs(draft.x2 - draft.x1), h = Math.abs(draft.y2 - draft.y1);
      if (draft.type === "rect" || draft.type === "ellipse") {
        if (w > 4 || h > 4) {
          const el = { id: uid(), type: draft.type, x: Math.min(draft.x1, draft.x2), y: Math.min(draft.y1, draft.y2),
            w: Math.max(w, 20), h: Math.max(h, 20), stroke: draft.stroke, strokeWidth: draft.strokeWidth,
            strokeStyle: draft.strokeStyle, fill: draft.fill, fillOpacity: draft.fillOpacity, note: "" };
          setElements((els) => [...els, el]); setSelectedId(el.id);
        }
      } else {
        const el = { id: uid(), type: draft.type, x1: draft.x1, y1: draft.y1, x2: draft.x2, y2: draft.y2,
          stroke: draft.stroke, strokeWidth: draft.strokeWidth, strokeStyle: draft.strokeStyle, note: "", label: "" };
        setElements((els) => [...els, el]); setSelectedId(el.id);
      }
      setDraft(null); setTool("select");
    }
    dragRef.current = null;
    bgDragRef.current = null;
  };

  const startDragElement = (e, el, endpoint) => {
    if (tool !== "select") return;
    e.stopPropagation(); setSelectedId(el.id); setBgSelected(false);
    const { x, y } = svgPoint(e);
    if (el.type === "line" || el.type === "arrow") {
      dragRef.current = { id: el.id, endpoint, offsetX: x - el.x1, offsetY: y - el.y1, dx: el.x2 - el.x1, dy: el.y2 - el.y1 };
    } else {
      dragRef.current = { id: el.id, offsetX: x - el.x, offsetY: y - el.y };
    }
  };

  const startBgDrag = (e) => {
    const { x, y } = svgPoint(e);
    bgDragRef.current = { mode: "move", offsetX: x - background.x, offsetY: y - background.y };
  };
  const startBgResize = (e) => {
    const { x, y } = svgPoint(e);
    bgDragRef.current = { mode: "resize", startX: x, startY: y, startW: background.w, startH: background.h };
  };

  const placeIcon = (e) => {
    if (tool !== "icon") return;
    const { x, y } = svgPoint(e);
    const el = { id: uid(), type: "icon", x, y, iconKey: pickedIcon, note: "" };
    setElements((els) => [...els, el]); setSelectedId(el.id);
  };

  const updateSelected = (patch) => setElements((els) => els.map((el) => (el.id === selectedId ? { ...el, ...patch } : el)));
  const deleteSelected = () => {
    const el = elements.find((e) => e.id === selectedId);
    if (el && el.type === "image" && el.assetPath) {
      deleteAsset(el.assetPath).catch(() => {}); // 清理磁盘上不再使用的图片文件，失败也不影响主流程
    }
    setElements((els) => els.filter((el) => el.id !== selectedId));
    setSelectedId(null);
  };

  // 导入图标：不再把图片编码成 base64 塞进书籍数据里，而是先存成磁盘上的独立文件，
  // 画布上的元素只保存一个相对路径（assetPath），显示时按需读取。
  const importIcon = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const relPath = await saveAsset(bookId, reader.result);
        const el = { id: uid(), type: "image", x: 60, y: 60, w: 64, h: 64, assetPath: relPath, note: "" };
        setElements((els) => [...els, el]); setSelectedId(el.id);
      } catch (err) {
        onError?.("图片保存失败：" + String(err));
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // 导入背景图（主要给地图模块用来放世界地图/城市平面图等底图）：
  // 同样存成独立文件；同时读取图片的原始尺寸，按最长边不超过 800px 的比例定一个初始显示大小，
  // 避免导入一张很大的图直接把画布撑得过大。
  const importBackground = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const relPath = await saveAsset(bookId, reader.result);
        const naturalSize = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.width, h: img.height });
          img.onerror = () => resolve({ w: 640, h: 400 });
          img.src = reader.result;
        });
        const maxSide = 800;
        const scale = Math.min(1, maxSide / Math.max(naturalSize.w, naturalSize.h, 1));
        setBackground({
          assetPath: relPath, x: 40, y: 40,
          w: Math.max(30, Math.round(naturalSize.w * scale)),
          h: Math.max(30, Math.round(naturalSize.h * scale)),
          locked: false, opacity: 1,
        });
        setBgSelected(true); setSelectedId(null);
      } catch (err) {
        onError?.("背景图导入失败：" + String(err));
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const removeBackground = () => {
    if (background?.assetPath) deleteAsset(background.assetPath).catch(() => {});
    setBackground(null);
    setBgSelected(false);
  };

  const dashArray = (style) => (style === "dashed" ? "6,4" : style === "dotted" ? "1.5,4" : "none");
  const bgInteractive = !!background && !background.locked && tool === "select";

  return (
    <div className="draw-page">
      <div className="page-topbar">
        <input className="page-name" value={name} onChange={(e) => { setName(e.target.value); onChange((p) => ({ ...p, name: e.target.value })); }} />
        <span className="tag" style={{ background: "#8a5a2b" }}>绘图区</span>
      </div>
      <div className="draw-toolbar">
        {TOOLS.map((t) => (
          <button key={t.key} className={"tool-btn" + (tool === t.key ? " active" : "")} onClick={() => setTool(t.key)}>
            <span>{t.glyph}</span>{t.label}
          </button>
        ))}
        <div className="toolbar-sep" />
        <button className={"tool-btn" + (tool === "icon" ? " active" : "")} onClick={() => setTool("icon")}>
          {ICON_LIBRARY.find((i) => i.key === pickedIcon)?.glyph} 图标
        </button>
        <div className="icon-tray">
          {ICON_LIBRARY.map((ic) => (
            <button key={ic.key} title={ic.label} className={"icon-chip" + (pickedIcon === ic.key ? " active" : "")}
              onClick={() => { setPickedIcon(ic.key); setTool("icon"); }}>{ic.glyph}</button>
          ))}
        </div>
        <div className="toolbar-sep" />
        <label className="tool-btn" style={{ cursor: "pointer" }}>
          ⇪ 导入图标
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={importIcon} />
        </label>
        <div className="toolbar-sep" />
        <label className="tool-btn" style={{ cursor: "pointer" }}>
          🖼 {background ? "更换背景图" : "设置背景图"}
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={importBackground} />
        </label>
        {background && (
          <>
            <button className="tool-btn" onClick={() => setBackground({ locked: !background.locked })}>
              {background.locked ? "🔒 已锁定" : "🔓 未锁定"}
            </button>
            <button className="tool-btn" onClick={removeBackground}>移除背景</button>
          </>
        )}
        <div className="toolbar-sep" />
        <div className="zoom-controls">
          <button className="tool-btn zoom-btn" onClick={zoomOut} title="缩小">－</button>
          <button className="tool-btn zoom-readout" onClick={zoomReset} title="点击恢复 100%">{Math.round(zoom * 100)}%</button>
          <button className="tool-btn zoom-btn" onClick={zoomIn} title="放大">＋</button>
        </div>
      </div>
      <div className="draw-body">
        <div className="canvas-wrap" ref={wrapRef} onWheel={handleWheel}>
          <div className="canvas-scale" style={{ width: 1600 * zoom, height: 1000 * zoom }}>
          <svg ref={svgRef} className={"canvas-svg" + (tool === "select" ? " select-mode" : "") + (isPanMode ? " pan-mode" : "")} width={1600} height={1000}
            style={{ transform: `scale(${zoom})`, transformOrigin: "0 0" }}
            onMouseDown={(e) => {
              if (isPanMode) { startPan(e); return; }
              handleCanvasDown(e); placeIcon(e);
              if (tool === "select") { setSelectedId(null); setBgSelected(false); }
            }}
            onMouseMove={handleCanvasMove} onMouseUp={handleCanvasUp} onMouseLeave={handleCanvasUp}>
            <defs>
              <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6 Z" fill="#33302a" />
              </marker>
            </defs>

            {background && (
              <BackgroundLayer
                background={background}
                selected={bgSelected}
                interactive={bgInteractive}
                onSelect={() => { setBgSelected(true); setSelectedId(null); }}
                onDragStart={startBgDrag}
                onResizeStart={startBgResize}
              />
            )}

            {elements.map((el) => renderElement(el, selectedId === el.id, startDragElement, dashArray))}
            {draft && (draft.type === "rect" ? (
              <rect x={Math.min(draft.x1, draft.x2)} y={Math.min(draft.y1, draft.y2)} width={Math.abs(draft.x2 - draft.x1)} height={Math.abs(draft.y2 - draft.y1)}
                fill={draft.fill} fillOpacity={draft.fillOpacity} stroke={draft.stroke} strokeWidth={draft.strokeWidth} />
            ) : draft.type === "ellipse" ? (
              <ellipse cx={(draft.x1 + draft.x2) / 2} cy={(draft.y1 + draft.y2) / 2} rx={Math.abs(draft.x2 - draft.x1) / 2} ry={Math.abs(draft.y2 - draft.y1) / 2}
                fill={draft.fill} fillOpacity={draft.fillOpacity} stroke={draft.stroke} strokeWidth={draft.strokeWidth} />
            ) : (
              <line x1={draft.x1} y1={draft.y1} x2={draft.x2} y2={draft.y2} stroke={draft.stroke} strokeWidth={draft.strokeWidth}
                markerEnd={draft.type === "arrow" ? "url(#arrowhead)" : undefined} />
            ))}
          </svg>
          </div>
        </div>
        <div className="style-panel">
          {bgSelected && background ? (
            <BackgroundInspector background={background} onPatch={(patch) => setBackground(patch)} onRemove={removeBackground} />
          ) : !selected ? (
            <div className="panel-empty">选中一个元素以编辑样式与备注，<br />或从左上工具栏选择绘图工具在画布上拖拽创建。<br /><br />地图页可以点击"设置背景图"导入底图，作为独立的背景图层使用。</div>
          ) : (
            <ElementInspector el={selected} onPatch={updateSelected} onDelete={deleteSelected} />
          )}
        </div>
      </div>
    </div>
  );
}

/* 背景图层：渲染在所有绘图元素之下。未锁定时可拖动/缩放，锁定后完全不响应鼠标事件，
   避免整理画面时不小心碰到底图。 */
function BackgroundLayer({ background, selected, interactive, onSelect, onDragStart, onResizeStart }) {
  const url = useAssetDataUrl(background.assetPath);
  if (!url) {
    return (
      <g>
        <rect x={background.x} y={background.y} width={background.w} height={background.h} fill="#e5ddc8" stroke="#c9bda1" strokeDasharray="4,3" />
        <text x={background.x + 10} y={background.y + 20} fontSize="11" fill="#a89f8c">背景图加载中…</text>
      </g>
    );
  }
  return (
    <g>
      <image
        href={url} x={background.x} y={background.y} width={background.w} height={background.h}
        opacity={background.opacity ?? 1}
        style={{ cursor: interactive ? "move" : "default", pointerEvents: interactive ? "auto" : "none" }}
        onMouseDown={(e) => { e.stopPropagation(); onSelect(); onDragStart(e); }}
      />
      {selected && interactive && (
        <>
          <rect x={background.x} y={background.y} width={background.w} height={background.h} fill="none" stroke="#8a5a2b" strokeDasharray="4,3" pointerEvents="none" />
          <circle
            cx={background.x + background.w} cy={background.y + background.h} r={7}
            fill="#8a5a2b" stroke="#fff" strokeWidth="1.5"
            style={{ cursor: "nwse-resize" }}
            onMouseDown={(e) => { e.stopPropagation(); onSelect(); onResizeStart(e); }}
          />
        </>
      )}
    </g>
  );
}

function BackgroundInspector({ background, onPatch, onRemove }) {
  return (
    <div>
      <h4>背景图层设置</h4>
      <div className="field">
        <label>锁定状态</label>
        <div className="seg">
          <button className={!background.locked ? "on" : ""} onClick={() => onPatch({ locked: false })}>未锁定</button>
          <button className={background.locked ? "on" : ""} onClick={() => onPatch({ locked: true })}>已锁定</button>
        </div>
      </div>
      <div className="field">
        <label>不透明度：{Math.round((background.opacity ?? 1) * 100)}%</label>
        <input type="range" min="0.1" max="1" step="0.05" value={background.opacity ?? 1} onChange={(e) => onPatch({ opacity: Number(e.target.value) })} />
      </div>
      <div className="field" style={{ color: "var(--ink-soft)", fontSize: 11.5, lineHeight: 1.6 }}>
        未锁定时可直接拖动移动背景图，拖动右下角圆点缩放；标注完成后建议锁定，避免整理画面时误触移动底图。
      </div>
      <button className="delete-el-btn" onClick={onRemove}>移除背景图</button>
    </div>
  );
}

function renderElement(el, isSelected, startDrag, dashArray) {
  if (el.type === "rect") {
    return (
      <g key={el.id}>
        <rect x={el.x} y={el.y} width={el.w} height={el.h} fill={el.fill} fillOpacity={el.fillOpacity}
          stroke={el.stroke} strokeWidth={el.strokeWidth} strokeDasharray={dashArray(el.strokeStyle)}
          onMouseDown={(e) => startDrag(e, el)} style={{ cursor: "move" }} />
        {isSelected && <rect x={el.x - 2} y={el.y - 2} width={el.w + 4} height={el.h + 4} fill="none" stroke="#8a5a2b" strokeDasharray="3,3" pointerEvents="none" />}
      </g>
    );
  }
  if (el.type === "ellipse") {
    return (
      <g key={el.id}>
        <ellipse cx={el.x + el.w / 2} cy={el.y + el.h / 2} rx={el.w / 2} ry={el.h / 2} fill={el.fill} fillOpacity={el.fillOpacity}
          stroke={el.stroke} strokeWidth={el.strokeWidth} strokeDasharray={dashArray(el.strokeStyle)}
          onMouseDown={(e) => startDrag(e, el)} style={{ cursor: "move" }} />
        {isSelected && <rect x={el.x - 2} y={el.y - 2} width={el.w + 4} height={el.h + 4} fill="none" stroke="#8a5a2b" strokeDasharray="3,3" pointerEvents="none" />}
      </g>
    );
  }
  if (el.type === "line" || el.type === "arrow") {
    return (
      <g key={el.id}>
        <line x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} stroke={el.stroke} strokeWidth={el.strokeWidth}
          strokeDasharray={dashArray(el.strokeStyle)} markerEnd={el.type === "arrow" ? "url(#arrowhead)" : undefined}
          onMouseDown={(e) => startDrag(e, el)} style={{ cursor: "move" }} />
        {el.label && <text x={(el.x1 + el.x2) / 2} y={(el.y1 + el.y2) / 2 - 6} fontSize="11" fill="#33302a" textAnchor="middle">{el.label}</text>}
        {isSelected && (
          <>
            <circle cx={el.x1} cy={el.y1} r={5} fill="#fff" stroke="#8a5a2b" strokeWidth="2" onMouseDown={(e) => startDrag(e, el, "1")} style={{ cursor: "grab" }} />
            <circle cx={el.x2} cy={el.y2} r={5} fill="#fff" stroke="#8a5a2b" strokeWidth="2" onMouseDown={(e) => startDrag(e, el, "2")} style={{ cursor: "grab" }} />
          </>
        )}
      </g>
    );
  }
  if (el.type === "icon") {
    const ic = ICON_LIBRARY.find((i) => i.key === el.iconKey) || ICON_LIBRARY[0];
    return (
      <g key={el.id} onMouseDown={(e) => startDrag(e, el)} style={{ cursor: "move" }}>
        <circle cx={el.x} cy={el.y} r={16} fill="#f4efe3" stroke={isSelected ? "#8a5a2b" : "#c9bda1"} strokeWidth={isSelected ? 2 : 1.5} />
        <text x={el.x} y={el.y + 5} fontSize="15" textAnchor="middle" fill="#33302a">{ic.glyph}</text>
        {el.note && <circle cx={el.x + 11} cy={el.y - 11} r={3.5} fill="#8a5a2b" />}
      </g>
    );
  }
  if (el.type === "image") {
    return <ImageElement key={el.id} el={el} isSelected={isSelected} startDrag={startDrag} />;
  }
  if (el.type === "text") {
    // 这里特意不用 contentEditable：一个由 React 渲染内容、又允许浏览器直接编辑 DOM 的元素，
    // 两边对"内容应该是什么"会打架，容易在某些操作顺序下触发渲染异常（之前遇到的白屏问题就出在这里）。
    // 文字内容改在右侧"元素设置"面板里编辑，这里只负责显示和拖动。
    return (
      <foreignObject key={el.id} x={el.x} y={el.y - 10} width={260} height={40}>
        <div xmlns="http://www.w3.org/1999/xhtml"
          onMouseDown={(e) => { e.stopPropagation(); startDrag(e, el); }}
          style={{
            fontSize: 13, fontFamily: "Inter, sans-serif",
            color: el.color || "#33302a", fontWeight: el.bold ? 700 : 400,
            outline: isSelected ? "1px dashed #8a5a2b" : "none",
            padding: "2px 4px", display: "inline-block", cursor: "move", background: "transparent",
            userSelect: "none", whiteSpace: "pre-wrap",
          }}>{el.text}</div>
      </foreignObject>
    );
  }
  return null;
}

/* 图标/导入图片元素：图片内容从磁盘按需加载（el.assetPath），
   仍然兼容旧版本直接内嵌 base64 的写法（el.src），保证旧书籍数据不会因为升级而丢图。 */
function ImageElement({ el, isSelected, startDrag }) {
  const loaded = useAssetDataUrl(el.assetPath);
  const url = el.assetPath ? loaded : el.src;
  return (
    <g onMouseDown={(e) => startDrag(e, el)} style={{ cursor: "move" }}>
      {url ? (
        <image href={url} x={el.x} y={el.y} width={el.w} height={el.h} />
      ) : (
        <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="#e5ddc8" stroke="#c9bda1" strokeDasharray="3,3" />
      )}
      <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke={isSelected ? "#8a5a2b" : "transparent"} strokeWidth="2" />
      {el.note && <circle cx={el.x + el.w - 6} cy={el.y + 6} r={3.5} fill="#8a5a2b" />}
    </g>
  );
}

function ElementInspector({ el, onPatch, onDelete }) {
  const hasBorderFill = el.type === "rect" || el.type === "ellipse";
  const isLineLike = el.type === "line" || el.type === "arrow";
  return (
    <div>
      <h4>元素设置</h4>
      {isLineLike && (
        <div className="field">
          <label>连线文字标签</label>
          <input type="text" value={el.label || ""} onChange={(e) => onPatch({ label: e.target.value })} placeholder="如：暗中效忠" />
        </div>
      )}
      {el.type === "text" && (
        <div className="field">
          <label>文本内容</label>
          <textarea value={el.text} onChange={(e) => onPatch({ text: e.target.value })} />
        </div>
      )}
      {el.type === "text" && (
        <>
          <div className="field">
            <label>文字颜色</label>
            <input type="color" value={el.color || "#33302a"} onChange={(e) => onPatch({ color: e.target.value })} />
          </div>
          <div className="field">
            <label>字重</label>
            <div className="seg">
              <button className={!el.bold ? "on" : ""} onClick={() => onPatch({ bold: false })}>常规</button>
              <button className={el.bold ? "on" : ""} onClick={() => onPatch({ bold: true })}>加粗</button>
            </div>
          </div>
        </>
      )}
      {(hasBorderFill || isLineLike) && (
        <>
          <div className="field">
            <label>边框颜色</label>
            <input type="color" value={el.stroke} onChange={(e) => onPatch({ stroke: e.target.value })} />
          </div>
          <div className="field">
            <label>边框粗细：{el.strokeWidth}px</label>
            <input type="range" min="1" max="10" value={el.strokeWidth} onChange={(e) => onPatch({ strokeWidth: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>边框样式</label>
            <div className="seg">
              {["solid", "dashed", "dotted"].map((s) => (
                <button key={s} className={el.strokeStyle === s ? "on" : ""} onClick={() => onPatch({ strokeStyle: s })}>
                  {s === "solid" ? "实线" : s === "dashed" ? "虚线" : "点线"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {hasBorderFill && (
        <>
          <div className="field">
            <label>填充颜色</label>
            <input type="color" value={el.fill} onChange={(e) => onPatch({ fill: e.target.value })} />
          </div>
          <div className="field">
            <label>填充透明度：{Math.round(el.fillOpacity * 100)}%（0% = 完全透明）</label>
            <input type="range" min="0" max="1" step="0.05" value={el.fillOpacity} onChange={(e) => onPatch({ fillOpacity: Number(e.target.value) })} />
          </div>
        </>
      )}
      {(el.type === "icon" || el.type === "image" || hasBorderFill) && (
        <div className="field">
          <label>备注</label>
          <textarea value={el.note || ""} onChange={(e) => onPatch({ note: e.target.value })} placeholder="点击元素后可在此记录详细设定…" />
        </div>
      )}
      <button className="delete-el-btn" onClick={onDelete}>删除此元素</button>
    </div>
  );
}
