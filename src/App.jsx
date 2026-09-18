import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  getDataDir, chooseDataDir, listBooks, loadBook, saveBook, deleteBook as deleteBookFile,
  saveAsset, readAsset, deleteAsset, exportTextPages,
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
   Story-Box（故事魔盒）—— 小说创作工具 · Tauri 桌面版（本地文件存储）
   书籍 -> 模块（地图/人物/大纲/正文/自定义） -> 页面（绘图区/文字区/时间线/变量）
   每本书独立保存为 数据目录/books/{id}.json，方便备份与云盘同步迁移
   ============================================================ */

const uid = () => Math.random().toString(36).slice(2, 10);

// 初始模块预设：时间线不再作为独立模块（所有非正文模块都能添加时间线页面）
const MODULE_PRESETS = [
  { type: "map", name: "地图", glyph: "图", tint: "#3f6b5a" },
  { type: "character", name: "人物", glyph: "人", tint: "#8a6b3f" },
  { type: "outline", name: "大纲", glyph: "纲", tint: "#5a5c8a" },
  { type: "manuscript", name: "正文", glyph: "文", tint: "#4f6b8a" },
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

const PAGE_TYPE_DOT = { draw: "#8a5a2b", text: "#5a6b8a", timeline: "#5a8a6f", charvars: "#a3853f" };

/* ------------------------------------------------------------
   变量页（正文模块专用）的类目定义与数据规整。
   旧版数据只有 characters（角色名单），这里统一迁移成 4 类结构。
   ------------------------------------------------------------ */
const VAR_CATEGORIES = [
  { key: "char", label: "角色", maxLen: 4 },
  { key: "place", label: "地点", maxLen: 8 },
  { key: "force", label: "势力", maxLen: 8 },
  { key: "item", label: "物品", maxLen: 8 },
];
const MAX_VARS_PER_CATEGORY = 12;

// 把变量页内容规整成统一的 { categories: [{key,label,maxLen,items}] }
function normalizeVarContent(content) {
  const cats = content && Array.isArray(content.categories) ? content.categories : [];
  return {
    categories: VAR_CATEGORIES.map((def) => {
      const found = cats.find((c) => c && c.key === def.key);
      return {
        key: def.key,
        label: def.label,
        maxLen: def.maxLen,
        items: found && Array.isArray(found.items) ? found.items : [],
      };
    }),
  };
}

// 把富文本 HTML 转成纯文本（块级元素转成换行），用于导出 txt
function htmlToPlainText(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "UL", "OL", "TR", "BR"]);
  let out = "";
  const walk = (node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { out += child.textContent; return; }
      if (child.nodeType !== 1) return;
      const tag = child.tagName;
      if (tag === "BR") { out += "\n"; return; }
      if (tag === "LI") out += "• ";
      walk(child);
      if (BLOCK_TAGS.has(tag)) out += "\n";
    });
  };
  walk(container);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// 递归收集一棵页面树里所有文字页（不包含变量页），返回 [{ name, html }]
function collectTextPages(pages, out = []) {
  for (const p of pages) {
    if (p.pageType === "text") out.push({ name: p.name || "未命名", html: (p.content && p.content.html) || "" });
    if (p.children && p.children.length) collectTextPages(p.children, out);
  }
  return out;
}

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
      // "正文"模块固定带一个"变量"页，用来集中定义各类变量（角色/地点/势力/物品），供这个模块下所有文字页的变量板读取
      pages: m.type === "manuscript" ? [newPage("变量", "charvars")] : [],
    })),
  };
}

const DEFAULT_CELL_COLOR_LEGEND = [
  { key: "crisis", color: "#d9534f", label: "危机" },
  { key: "friend", color: "#4caf7d", label: "交友" },
  { key: "romance", color: "#e07ab0", label: "情缘" },
];
const DEFAULT_ICON_COLOR_LEGEND = [
  { key: "firstMeet", color: "#3f6b5a", label: "首次遇见" },
  { key: "firstArrive", color: "#8a5a2b", label: "首次到达" },
  { key: "again", color: "#5a5c8a", label: "二次出现" },
];

function newPage(name, pageType) {
  let content;
  let defaultName;
  if (pageType === "draw") {
    content = { elements: [] };
    defaultName = "新绘图页";
  } else if (pageType === "timeline") {
    content = {
      axis: { years: [] },
      characters: [],
      cells: {},
      cellColorLegend: DEFAULT_CELL_COLOR_LEGEND.map((c) => ({ ...c })),
      iconLegend: DEFAULT_ICON_COLOR_LEGEND.map((c) => ({ ...c })),
    };
    defaultName = "新时间线";
  } else if (pageType === "charvars") {
    content = normalizeVarContent({});
    defaultName = "变量";
  } else {
    content = { html: "" };
    defaultName = "新文字页";
  }
  return {
    id: uid(),
    name: name || defaultName,
    pageType, // 'draw' | 'text' | 'timeline' | 'charvars'
    content,
    children: [], // 子页面（同样是 draw/text/... 页面的数组），支持任意层级嵌套
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

/* ------------------------------------------------------------
   时间线"年→月→日→时辰"轴的一组纯函数工具。
   每一级节点的子级字段名是固定的（年用 months，月用 days，日用 hours，时辰没有下一级），
   所以可以直接根据节点自己身上有哪个字段来判断它是哪一级、该往哪个字段递归，
   不需要额外传"当前层级"这种参数，代码简单很多。
   ------------------------------------------------------------ */

const AXIS_CHILD_KEY = { year: "months", month: "days", day: "hours" };
const AXIS_NEXT_LEVEL = { year: "month", month: "day", day: "hour" };

function axisChildrenKeyOf(node) {
  if ("months" in node) return "months";
  if ("days" in node) return "days";
  if ("hours" in node) return "hours";
  return null; // 时辰节点，没有下一级
}

function newAxisNode(name) {
  return { id: uid(), name };
}

// 按 id 递归查找并替换某个轴节点
function mapAxisTree(nodes, id, fn) {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    const key = axisChildrenKeyOf(n);
    if (key && n[key] && n[key].length) return { ...n, [key]: mapAxisTree(n[key], id, fn) };
    return n;
  });
}

// 在某个节点的子级数组里，于目标节点前/后插入一个新的同级节点；nodes 是"父级数组"本身
function insertSiblingInTree(nodes, siblingId, newNode, after) {
  const idx = nodes.findIndex((n) => n.id === siblingId);
  if (idx !== -1) {
    const copy = nodes.slice();
    copy.splice(after ? idx + 1 : idx, 0, newNode);
    return copy;
  }
  return nodes.map((n) => {
    const key = axisChildrenKeyOf(n);
    if (key && n[key] && n[key].length) return { ...n, [key]: insertSiblingInTree(n[key], siblingId, newNode, after) };
    return n;
  });
}

// 给某个节点新增第一个子级（年加月/月加日/日加时辰）
function addChildInTree(nodes, parentId, childKey, newNode) {
  return nodes.map((n) => {
    if (n.id === parentId) return { ...n, [childKey]: [...(n[childKey] || []), newNode] };
    const key = axisChildrenKeyOf(n);
    if (key && n[key] && n[key].length) return { ...n, [key]: addChildInTree(n[key], parentId, childKey, newNode) };
    return n;
  });
}

// 递归收集某个节点自身 + 其下所有子节点的 id（用于删除节点时一并清理它名下的格子数据）
function collectSubtreeIds(node, out) {
  out.push(node.id);
  const key = axisChildrenKeyOf(node);
  if (key && node[key]) node[key].forEach((c) => collectSubtreeIds(c, out));
}

// 递归删除某个 id 对应的轴节点（连同其所有子节点）；返回 { years, removedIds }
function removeAxisNode(nodes, id) {
  let removedIds = [];
  const filtered = nodes.filter((n) => {
    if (n.id === id) {
      collectSubtreeIds(n, removedIds);
      return false;
    }
    return true;
  });
  if (removedIds.length) return { years: filtered, removedIds };
  const next = filtered.map((n) => {
    const key = axisChildrenKeyOf(n);
    if (key && n[key] && n[key].length) {
      const res = removeAxisNode(n[key], id);
      if (res.removedIds.length) { removedIds = res.removedIds; return { ...n, [key]: res.years }; }
    }
    return n;
  });
  return { years: next, removedIds };
}

/**
 * 把"年→月→日→时辰"的树，按深度优先遍历成四行表头（年/月/日/时辰）+ 叶子列清单。
 * 某个节点只要还没有下一级子节点，它自己就是"叶子列"（可以直接挂数据），
 * rowSpan 会一路撑到表头最后一行；一旦有子节点，它就是纯表头，rowSpan=1，
 * colSpan = 它名下叶子列的总数。这样不同年/月/日深度不一致也能正常渲染。
 */
function buildTimelineHeader(years) {
  const headerRows = [[], [], [], []]; // 年 / 月 / 日 / 时辰
  const leafColumns = []; // { id, path: {year,month,day,hour} }

  function countLeaves(node) {
    const key = axisChildrenKeyOf(node);
    if (!key || !node[key] || node[key].length === 0) return 1;
    return node[key].reduce((sum, c) => sum + countLeaves(c), 0);
  }

  function walk(node, rowIndex, path) {
    const key = axisChildrenKeyOf(node);
    const hasChildren = key && node[key] && node[key].length > 0;
    const colSpan = hasChildren ? countLeaves(node) : 1;
    const rowSpan = hasChildren ? 1 : 4 - rowIndex;
    headerRows[rowIndex].push({ id: node.id, name: node.name, colSpan, rowSpan, level: LEVEL_NAMES[rowIndex] });
    const nextPath = { ...path, [LEVEL_NAMES[rowIndex]]: node.name };
    if (hasChildren) {
      node[key].forEach((child) => walk(child, rowIndex + 1, nextPath));
    } else {
      leafColumns.push({ id: node.id, path: nextPath });
    }
  }

  years.forEach((y) => walk(y, 0, {}));
  return { headerRows, leafColumns };
}
const LEVEL_NAMES = ["year", "month", "day", "hour"];
const LEVEL_LABELS = { year: "年", month: "月", day: "日", hour: "时辰" };

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
  const dlg = useDialog();

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

  // 正文模块一键导出：模块内所有文字页面（含各层级子页面）各导出一个 txt
  const exportManuscriptModule = async (mid) => {
    const mod = currentBook?.modules.find((m) => m.id === mid);
    if (!mod || mod.type !== "manuscript") return;
    const pages = collectTextPages(mod.pages);
    if (pages.length === 0) {
      flashToast("该模块里还没有文字页面，没有可导出的内容");
      return;
    }
    try {
      const count = await exportTextPages(pages.map((p) => ({ name: p.name, content: htmlToPlainText(p.html) })));
      if (count > 0) flashToast(`已导出 ${count} 个文字页面为 txt`);
    } catch (e) {
      flashToast("导出失败：" + String(e));
    }
  };

  if (bookIndex === null || opening) {
    return <Shell><div className="loading">{opening ? "正在打开书籍…" : "正在载入书籍库…"}</div></Shell>;
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
            // 新建自定义模块：插到第一个"正文"模块之前（与地图/人物/大纲等普通模块排在一起）
            const mod = { id: uid(), name: "新模块", type: "custom", tint: "#6b6558", pages: [] };
            setCurrentBook((b) => {
              const idx = b.modules.findIndex((m) => m.type === "manuscript");
              const modules = idx === -1
                ? [...b.modules, mod]
                : [...b.modules.slice(0, idx), mod, ...b.modules.slice(idx)];
              return { ...b, modules };
            });
          }}
          onAddManuscriptModule={() => {
            const preset = MODULE_PRESETS.find((p) => p.type === "manuscript");
            setCurrentBook((b) => ({
              ...b,
              modules: [...b.modules, { id: uid(), name: preset.name, type: "manuscript", tint: preset.tint, pages: [newPage("变量", "charvars")] }],
            }));
          }}
          onExportModule={(mid) => exportManuscriptModule(mid)}
          onRenameModule={(mid, name) => {
            setCurrentBook((b) => ({ ...b, modules: b.modules.map((m) => (m.id === mid ? { ...m, name } : m)) }));
          }}
          onDeleteModule={async (mid, moduleName) => {
            const ok = await dlg.confirm(
              `删除模块「${moduleName}」？该模块下的所有页面都会被一并删除，且不会进入回收站。`,
              "删除模块"
            );
            if (ok) {
              setCurrentBook((b) => ({ ...b, modules: b.modules.filter((m) => m.id !== mid) }));
              if (currentModuleId === mid) { setCurrentModuleId(null); setCurrentPageId(null); }
            }
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
            const mod = currentBook.modules.find((m) => m.id === mid);
            const page = mod ? findPageInTree(mod.pages, pid) : null;
            if (page && page.pageType === "charvars") {
              flashToast("「变量」页面是正文模块的固定页面，不能删除");
              return;
            }
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
          ) : currentPage.pageType === "timeline" ? (
            <TimelinePage page={currentPage} onChange={updateCurrentPage} />
          ) : currentPage.pageType === "charvars" ? (
            <CharacterVarsPage page={currentPage} onChange={updateCurrentPage} />
          ) : (
            <TextPage
              page={currentPage}
              onChange={updateCurrentPage}
              variables={
                currentModule?.type === "manuscript"
                  ? normalizeVarContent(currentModule.pages.find((p) => p.pageType === "charvars")?.content).categories
                  : null
              }
            />
          )}
        </main>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </Shell>
  );
}

/* ============================================================ 应用内弹窗：confirm / alert / prompt
   Tauri v2 的 WebView（wry）没有实现 JS 原生对话框，window.confirm / prompt / alert 在打包后的
   桌面端里常常静默失效（不弹窗、直接返回默认值），所以这里用一套自绘的模态框统一替代。
   用法：const dlg = useDialog(); await dlg.confirm("确定删除？") / await dlg.prompt("名称：", "默认")
   confirm 返回 true/false，prompt 返回字符串（取消/空输入返回 null）。
   ============================================================ */

const DialogContext = React.createContext(null);
const useDialog = () => React.useContext(DialogContext);

export function DialogProvider({ children }) {
  const [dlg, setDlg] = useState(null); // { kind, title, message, defaultValue, resolve }
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const close = (result) => {
    if (!dlg) return;
    dlg.resolve(result);
    setDlg(null);
  };

  const api = useMemo(() => ({
    confirm: (message, title = "确认操作") => new Promise((resolve) => setDlg({ kind: "confirm", title, message, resolve })),
    alert: (message, title = "提示") => new Promise((resolve) => setDlg({ kind: "alert", title, message, resolve })),
    prompt: (message, defaultValue = "", title = "输入") =>
      new Promise((resolve) => { setValue(defaultValue); setDlg({ kind: "prompt", title, message, resolve }); }),
  }), []);

  // prompt 弹出时自动聚焦并全选已有内容
  useEffect(() => {
    if (!dlg) return;
    if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [dlg]);
  useEffect(() => {
    if (!dlg) return;
    const onKey = (e) => { if (e.key === "Escape") close(dlg.kind === "prompt" ? null : false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dlg]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dlg && (
        <div className="modal-mask" onMouseDown={() => close(dlg.kind === "prompt" ? null : false)}>
          <div className="modal-box" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-title">{dlg.title}</div>
            <div className="modal-msg">{dlg.message}</div>
            {dlg.kind === "prompt" && (
              <input
                ref={inputRef} className="modal-input" value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); close(value.trim() || null); } }}
              />
            )}
            <div className="modal-actions">
              {dlg.kind !== "alert" && (
                <button className="modal-btn" onClick={() => close(dlg.kind === "prompt" ? null : false)}>取消</button>
              )}
              <button
                className="modal-btn primary"
                onClick={() => close(dlg.kind === "prompt" ? (value.trim() || null) : true)}
              >确定</button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
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
        .charvars-body { padding: 24px 32px; max-width: none; overflow-y: auto; flex: 1; min-height: 0; }
        .charvars-hint { font-size: 12px; color: var(--ink-soft); line-height: 1.7; margin-bottom: 18px; background: var(--panel);
          border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; max-width: 1080px; }
        .charvars-empty { font-size: 12px; color: var(--ink-soft); padding: 8px 0; }
        /* 变量页：四个类别横向排布 */
        .vars-body { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
        .vars-cat { flex: 1; min-width: 216px; max-width: 320px; background: var(--panel); border: 1px solid var(--line);
          border-radius: 8px; padding: 12px 14px; }
        .vars-cat-title { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
        .vars-cat-title span:first-child { font-family: 'Noto Serif SC', serif; font-weight: 700; font-size: 14px; }
        .vars-cat-count { font-size: 10.5px; color: var(--ink-soft); }
        .vars-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
        .vars-order { display: flex; flex-direction: column; gap: 1px; }
        .vars-order button { width: 16px; height: 13px; font-size: 7px; border: 1px solid var(--line); background: var(--panel);
          cursor: pointer; color: var(--ink-soft); padding: 0; line-height: 1; }
        .vars-order button:disabled { opacity: 0.3; cursor: default; }
        .vars-order button:first-child { border-radius: 3px 3px 0 0; }
        .vars-order button:last-child { border-radius: 0 0 3px 3px; }
        .vars-index { font-size: 11px; color: var(--ink-soft); width: 20px; text-align: right; flex-shrink: 0;
          font-variant-numeric: tabular-nums; }
        .vars-row input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 5px; padding: 5px 8px; font-size: 13px;
          font-family: inherit; background: #fff; color: var(--ink); }
        .vars-cat-add { width: 100%; margin-top: 4px; padding: 6px; border: 1px dashed var(--line); background: none;
          border-radius: 5px; cursor: pointer; font-size: 12px; color: var(--ink-soft); }
        .vars-cat-add:hover { border-color: var(--accent); color: var(--accent); }
        .vars-cat-full { width: 100%; margin-top: 4px; padding: 6px; text-align: center; font-size: 11px; color: var(--ink-soft);
          border: 1px dashed var(--line); border-radius: 5px; opacity: 0.7; }

        /* ---------- 时间线 ---------- */
        .timeline-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .legend-bar { display: flex; flex-wrap: wrap; gap: 14px; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); font-size: 11.5px; }
        .legend-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .legend-group-label { color: var(--ink-soft); font-weight: 600; margin-right: 2px; }
        .legend-chip { display: flex; align-items: center; gap: 4px; border: 1px solid var(--line); background: var(--paper);
          border-radius: 12px; padding: 2px 8px 2px 4px; }
        .legend-chip input[type=color] { width: 16px; height: 16px; border: none; padding: 0; border-radius: 50%; overflow: hidden; cursor: pointer; }
        .legend-chip span { cursor: pointer; color: var(--ink); }
        .legend-chip span:hover { color: var(--accent); }
        .legend-chip .legend-del { border: none; background: none; cursor: pointer; color: var(--ink-soft); font-size: 10px; padding: 0 0 0 2px; }
        .legend-chip .legend-del:hover { color: var(--danger); }
        .legend-add-btn { border: 1px dashed var(--line); background: none; border-radius: 12px; padding: 2px 10px; cursor: pointer; color: var(--ink-soft); }
        .legend-add-btn:hover { border-color: var(--accent); color: var(--accent); }

        .timeline-toolbar { display: flex; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--line); background: var(--paper); }
        .timeline-toolbar button { font-size: 11.5px; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
          padding: 4px 10px; border-radius: 5px; cursor: pointer; }
        .timeline-toolbar button:hover { border-color: var(--accent); color: var(--accent); }

        .timeline-body { flex: 1; display: flex; min-height: 0; }
        .timeline-scroll { flex: 1; overflow: auto; background: var(--paper); }
        .timeline-table { border-collapse: separate; border-spacing: 0; font-size: 11.5px; }
        .timeline-table th, .timeline-table td { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
        .tl-corner { position: sticky; top: 0; left: 0; z-index: 5; background: var(--panel); }
        .tl-head-cell { position: sticky; background: var(--panel); padding: 3px 4px; min-width: 56px; vertical-align: top; z-index: 3; }
        .tl-head-row-0 .tl-head-cell { top: 0; }
        .tl-head-row-1 .tl-head-cell { top: 30px; }
        .tl-head-row-2 .tl-head-cell { top: 60px; }
        .tl-head-row-3 .tl-head-cell { top: 90px; }
        .tl-head-name { font-weight: 600; color: var(--ink); cursor: pointer; text-align: center; padding: 2px 0; }
        .tl-head-name:hover { color: var(--accent); }
        .tl-head-actions { display: flex; justify-content: center; gap: 2px; opacity: 0; }
        .tl-head-cell:hover .tl-head-actions { opacity: 1; }
        .tl-head-actions button { border: none; background: rgba(0,0,0,0.06); border-radius: 3px; width: 15px; height: 15px;
          font-size: 9px; cursor: pointer; color: var(--ink-soft); padding: 0; line-height: 1; }
        .tl-head-actions button:hover { background: var(--accent); color: #fff; }
        .tl-add-child { display: block; margin: 2px auto 0; border: 1px dashed var(--line); background: none; border-radius: 3px;
          font-size: 9px; color: var(--ink-soft); cursor: pointer; opacity: 0; padding: 0 4px; }
        .tl-head-cell:hover .tl-add-child { opacity: 1; }
        .tl-add-child:hover { border-color: var(--accent); color: var(--accent); }

        .tl-char-cell, .tl-row-cell { position: sticky; background: var(--panel); padding: 5px 8px; z-index: 2; }
        /* 两个行首列都用固定宽度，保证吸顶表头的左上角（colSpan=2）与下方两列严格对齐，
           否则列宽随内容伸缩时，吸左的行名列会遮住第一个数据列 */
        .tl-char-cell { left: 0; width: 92px; min-width: 92px; max-width: 92px; font-weight: 600; color: var(--ink); z-index: 4; }
        .tl-row-cell { left: 92px; width: 92px; min-width: 92px; max-width: 92px; color: var(--ink-soft); z-index: 2; }
        .tl-char-name { cursor: pointer; }
        .tl-char-name:hover { color: var(--accent); }
        .tl-row-name { cursor: pointer; }
        .tl-row-name:hover { color: var(--accent); }
        .tl-char-actions, .tl-row-actions { display: flex; gap: 2px; margin-top: 3px; opacity: 0; }
        .tl-char-cell:hover .tl-char-actions, .tl-row-cell:hover .tl-row-actions { opacity: 1; }
        .tl-char-actions button, .tl-row-actions button { border: none; background: rgba(0,0,0,0.06); border-radius: 3px;
          font-size: 9px; cursor: pointer; color: var(--ink-soft); padding: 1px 4px; }
        .tl-char-actions button:hover, .tl-row-actions button:hover { background: var(--accent); color: #fff; }
        .tl-char-group-start .tl-char-cell, .tl-char-group-start .tl-row-cell, .tl-char-group-start .tl-data-cell {
          border-top: 3px solid var(--ink); }

        .tl-data-cell { min-width: 68px; max-width: 96px; height: 40px; padding: 3px 4px; cursor: pointer; vertical-align: top; }
        .tl-data-cell:hover { outline: 1px solid var(--accent-soft); outline-offset: -1px; }
        .tl-data-cell.selected { outline: 2px solid var(--accent); outline-offset: -2px; }
        .tl-data-text { font-size: 11px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tl-data-icons { display: flex; gap: 2px; margin-top: 2px; align-items: center; }
        .tl-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; border: 1px solid rgba(0,0,0,0.15); }
        .tl-dot-more { font-size: 9px; color: var(--ink-soft); }

        .tl-cell-panel { width: 260px; flex-shrink: 0; border-left: 1px solid var(--line); background: var(--panel); padding: 16px; overflow-y: auto; font-size: 12.5px; }
        .tl-cell-panel h4 { font-family: 'Noto Serif SC', serif; font-size: 13.5px; margin: 0 0 12px; }
        .tl-color-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
        .tl-color-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
        .tl-color-swatch.on { border-color: var(--ink); }
        .tl-color-none { width: 22px; height: 22px; border-radius: 50%; border: 1px dashed var(--line); background: #fff;
          cursor: pointer; font-size: 10px; color: var(--ink-soft); }
        .tl-icon-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
        .tl-icon-row { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 5px; padding: 5px 7px; background: #fff; }
        .tl-icon-row .tl-dot { width: 13px; height: 13px; }
        .tl-icon-row .lbl { font-size: 11px; color: var(--ink); font-weight: 600; }
        .tl-icon-row .note { font-size: 10.5px; color: var(--ink-soft); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tl-icon-row button { border: none; background: none; color: var(--danger); cursor: pointer; font-size: 10px; }
        .tl-icon-add-row { display: flex; flex-wrap: wrap; gap: 5px; }
        .tl-icon-add-row button.tl-color-swatch { width: 20px; height: 20px; }
        .main-area { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--paper); }
        .empty-state { margin: auto; text-align: center; color: var(--ink-soft); font-size: 13.5px; }
        .empty-state .big { font-family: 'Noto Serif SC', serif; font-size: 20px; color: var(--ink); margin-bottom: 6px; }
        .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--ink);
          color: var(--paper); padding: 8px 16px; border-radius: 6px; font-size: 12.5px; max-width: 70%; text-align: center; }
        .library { margin: auto; width: 100%; max-width: 880px; padding: 48px 32px; overflow-y: auto; max-height: 100%; }
        .library-brand { font-family: 'Inter', sans-serif; font-size: 12px; letter-spacing: 1px; text-transform: none;
          color: var(--accent); font-weight: 600; margin-bottom: 10px; }
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
        .text-page { display: flex; flex-direction: row; height: 100%; min-height: 0; }
        .text-page-main { display: flex; flex-direction: column; flex: 1; min-width: 0; height: 100%; }
        /* 文字页上边栏的变量板：角色 / 地点 / 势力 / 物品 四类，一组一行，每组最多 12 个 */
        .vars-bar { display: flex; flex-direction: column; gap: 6px; padding: 8px 20px;
          border-bottom: 1px solid var(--line); background: var(--paper); max-height: 168px; overflow-y: auto; }
        .vars-group { display: flex; align-items: flex-start; gap: 10px; }
        .vars-group-label { font-size: 11.5px; font-weight: 600; color: var(--ink-soft); padding-top: 4px;
          width: 36px; flex-shrink: 0; }
        .vars-chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0; }
        .vars-chip { font-size: 12px; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
          border-radius: 4px; padding: 3px 8px; cursor: pointer; }
        .vars-chip:hover { border-color: var(--accent); color: var(--accent); background: #fff; }
        .vars-empty { font-size: 11px; color: #a89f8c; padding: 3px 0; }
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
        .modal-mask { position: fixed; inset: 0; background: rgba(44,42,36,0.35); z-index: 100;
          display: flex; align-items: center; justify-content: center; }
        .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.18); padding: 18px 20px 14px; width: 340px; max-width: 86vw; }
        .modal-title { font-family: 'Noto Serif SC', serif; font-weight: 700; font-size: 14.5px; margin-bottom: 8px; }
        .modal-msg { font-size: 13px; line-height: 1.7; color: var(--ink); white-space: pre-wrap; }
        .modal-input { width: 100%; margin-top: 12px; border: 1px solid var(--line); border-radius: 5px;
          padding: 7px 9px; font-size: 13px; font-family: inherit; background: #fff; color: var(--ink); }
        .modal-input:focus { outline: none; border-color: var(--accent); }
        .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
        .modal-btn { border: 1px solid var(--line); background: var(--paper); color: var(--ink);
          border-radius: 5px; padding: 6px 16px; font-size: 12.5px; cursor: pointer; }
        .modal-btn:hover { border-color: var(--accent); color: var(--accent); }
        .modal-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
        .modal-btn.primary:hover { background: #755024; color: #fff; }
      `}</style>
      {children}
    </div>
  );
}

/* ============================================================ 书库首页 */

function BookLibrary({ books, dataDir, onChooseDataDir, onOpen, onCreate, onDelete, onRename }) {
  const dlg = useDialog();
  return (
    <div className="library">
      <div className="library-brand">Story-Box · 故事魔盒</div>
      <h1>书籍库</h1>
      <div className="sub">选择一本书继续创作，或新建一本书开始创作。</div>
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
                onClick={async (e) => {
                  e.stopPropagation();
                  const name = await dlg.prompt("书籍名称：", b.name, "重命名书籍");
                  if (name) onRename(b.id, name);
                }}
              >✎</button>
              <button
                className="icon-action danger"
                title="删除"
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await dlg.confirm(
                    `确定删除《${b.name}》吗？书籍下的所有模块与页面都会被删除，文件会被移到回收目录，可从磁盘手动恢复。`,
                    "删除书籍"
                  );
                  if (ok) onDelete(b.id);
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
          onClick={async () => {
            const name = await dlg.prompt("书籍名称：", "未命名书籍", "新建书籍");
            if (name) onCreate(name);
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
  onSelectPage, onAddModule, onAddManuscriptModule, onExportModule, onRenameModule, onDeleteModule, onAddPage, onAddSubPage, onRenamePage, onDeletePage,
}) {
  const [openModules, setOpenModules] = useState(() => new Set(book.modules.map((m) => m.id)));
  const [collapsedPages, setCollapsedPages] = useState(() => new Set());
  const dlg = useDialog();
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
  const findPreset = (type) => MODULE_PRESETS.find((p) => p.type === type);

  // 单个模块块的渲染（地图/人物/大纲/自定义/正文 都用这一份）
  const renderModule = (m) => {
    const preset = findPreset(m.type);
    const glyph = preset ? preset.glyph : "自";
    const open = openModules.has(m.id);
    return (
      <div className="module-block" key={m.id}>
        <div className="module-title" onClick={() => toggle(m.id)}>
          <div className="module-badge" style={{ background: m.tint }}>{glyph}</div>
          <input value={m.name} onClick={(e) => e.stopPropagation()} onChange={(e) => onRenameModule(m.id, e.target.value)} />
          {m.type === "manuscript" && (
            <button
              className="icon-action"
              title="导出本模块所有文字页面为 txt"
              onClick={(e) => { e.stopPropagation(); onExportModule(m.id); }}
            >⇩</button>
          )}
          <button
            className="icon-action danger"
            title="删除模块"
            onClick={(e) => { e.stopPropagation(); onDeleteModule(m.id, m.name); }}
          >✕</button>
          <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
        </div>
        {open && (
          <>
            <div className="page-list">
              {m.pages.map((p) => (
                <PageNode
                  key={p.id}
                  moduleId={m.id}
                  moduleType={m.type}
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
              <button onClick={async () => onAddPage(m.id, "text", (await dlg.prompt("文字页名称：", "新文字页", "新建文字页")) || "新文字页")}>+ 文字区</button>
              {m.type !== "manuscript" && (
                <>
                  <button onClick={async () => onAddPage(m.id, "draw", (await dlg.prompt("绘图页名称：", "新绘图页", "新建绘图页")) || "新绘图页")}>+ 绘图区</button>
                  <button onClick={async () => onAddPage(m.id, "timeline", (await dlg.prompt("时间线名称：", "新时间线", "新建时间线")) || "新时间线")}>+ 时间线</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  // 布局：普通模块（含自定义）在上 → 新建自定义模块按钮 → 正文模块 → 新建正文模块按钮
  const normalModules = book.modules.filter((m) => m.type !== "manuscript");
  const manuscriptModules = book.modules.filter((m) => m.type === "manuscript");

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="sidebar-back" onClick={onBack}>← 返回书籍库</button>
        <div className="sidebar-booktitle-row">
          <div className="sidebar-booktitle">{book.name}</div>
          <button
            className="icon-action"
            title="重命名书籍"
            onClick={async () => {
              const name = await dlg.prompt("书籍名称：", book.name, "重命名书籍");
              if (name) onRenameBook(name);
            }}
          >✎</button>
        </div>
      </div>
      {normalModules.map(renderModule)}
      <button className="add-module-btn" onClick={onAddModule}>+ 新建自定义模块</button>
      {manuscriptModules.map(renderModule)}
      <button className="add-module-btn" onClick={onAddManuscriptModule}>+ 新建正文模块</button>
    </div>
  );
}

// 页面树的单个节点：自己 + 递归渲染子页面。缩进按层级递增，用来体现"页面下的子页面"这种嵌套关系。
function PageNode({ moduleId, moduleType, page, depth, currentPageId, collapsedPages, onTogglePage, onSelectPage, onRenamePage, onAddSubPage, onDeletePage }) {
  const hasChildren = page.children && page.children.length > 0;
  const collapsed = collapsedPages.has(page.id);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const rowRef = useRef(null);
  const dlg = useDialog();

  // 点击行外任意地方，自动收起"添加子页面"的类型选择小菜单
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDocClick = (e) => { if (rowRef.current && !rowRef.current.contains(e.target)) setAddMenuOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [addMenuOpen]);

  const SUB_PAGE_DEFAULT_NAMES = { draw: "新绘图页", text: "新文字页", timeline: "新时间线" };
  const addSub = async (type) => {
    setAddMenuOpen(false);
    const name = await dlg.prompt("子页面名称：", SUB_PAGE_DEFAULT_NAMES[type] || "新子页面", "新建子页面");
    if (name) onAddSubPage(moduleId, page.id, type, name);
  };

  // 子页面类型：正文模块只允许添加文字子页；其他模块还可以加绘图/时间线子页
  const subPageTypes = moduleType === "manuscript" ? ["text"] : ["text", "draw", "timeline"];
  const SUB_PAGE_MENU = {
    text: "📝 文字子页",
    draw: "🖌 绘图子页",
    timeline: "🕐 时间线子页",
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
            <span className="type-dot" style={{ background: PAGE_TYPE_DOT[page.pageType] || "#5a6b8a" }} />
          )}
          <span
            className="p-name"
            onDoubleClick={async (e) => {
              e.stopPropagation();
              const name = await dlg.prompt("重命名页面：", page.name, "重命名页面");
              if (name) onRenamePage(moduleId, page.id, name);
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
            onClick={async (e) => {
              e.stopPropagation();
              const ok = await dlg.confirm(
                hasChildren
                  ? `删除页面「${page.name}」？其下的子页面会一并删除，无法恢复。`
                  : `删除页面「${page.name}」？删除后无法恢复。`,
                "删除页面"
              );
              if (ok) onDeletePage(moduleId, page.id);
            }}
          >✕</button>
        </div>
        {addMenuOpen && (
          <div className="add-sub-menu" style={{ marginLeft: 44 + depth * 16 }}>
            {subPageTypes.map((t) => (
              <button key={t} onClick={() => addSub(t)}>{SUB_PAGE_MENU[t]}</button>
            ))}
          </div>
        )}
      </div>
      {hasChildren && !collapsed && page.children.map((child) => (
        <PageNode
          key={child.id}
          moduleId={moduleId}
          moduleType={moduleType}
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

function TextPage({ page, onChange, variables }) {
  const ref = useRef(null);
  const [name, setName] = useState(page.name);
  const typingTimer = useRef(null);
  const savedRangeRef = useRef(null);

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

  // 持续记录编辑器内最后一次光标/选区的位置，这样点击右侧角色面板插入名字时，
  // 即使焦点已经切到了面板按钮上，也能准确地插回到刚才光标所在的地方。
  useEffect(() => {
    const onSelChange = () => {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && ref.current && ref.current.contains(sel.anchorNode)) {
          savedRangeRef.current = sel.getRangeAt(0).cloneRange();
        }
      } catch (err) { /* 忽略选区读取失败，不影响正常编辑 */ }
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [page.id]);

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

  // 点击右侧角色面板里的名字，把它插入到正文当前光标处，方便写作时不用手打人名
  const insertCharacterName = (charName) => {
    try {
      const node = ref.current;
      if (!node) return;
      node.focus();
      const sel = window.getSelection();
      if (!sel) return;
      if (savedRangeRef.current && node.contains(savedRangeRef.current.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(savedRangeRef.current);
      } else {
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand("insertText", false, charName);
      if (sel.rangeCount > 0) savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      handleInput();
    } catch (err) {
      console.error("插入角色名失败：", err);
    }
  };

  // 变量板：正文模块才有（variables 为 null 时隐藏），按类别展示各 12 个变量，点击插入到光标处
  const hasVars = variables !== null && variables !== undefined;

  return (
    <div className="text-page">
      <div className="text-page-main">
        <div className="page-topbar">
          <input className="page-name" value={name} onChange={(e) => { setName(e.target.value); onChange((p) => ({ ...p, name: e.target.value })); }} />
          <button className="manual-save-btn" onClick={handleManualSave}>💾 立即保存</button>
          <span className="tag">文字区</span>
        </div>
        {hasVars && (
          <div className="vars-bar">
            {variables.map((cat) => (
              <div className="vars-group" key={cat.key}>
                <span className="vars-group-label">{cat.label}</span>
                <div className="vars-chips">
                  {cat.items.length === 0 ? (
                    <span className="vars-empty">无</span>
                  ) : (
                    cat.items.map((it) => (
                      <button key={it.id} className="vars-chip" title={"插入：" + it.name} onClick={() => insertCharacterName(it.name)}>{it.name}</button>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
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
          data-placeholder="在这里记录内容…支持加粗、列表、标题"
          onInput={handleInput}
          onBlur={(e) => {
            if (typingTimer.current) clearTimeout(typingTimer.current);
            onChange((p) => ({ ...p, content: { html: readHtml(e.currentTarget) } }), { immediate: true });
          }}
        />
      </div>
    </div>
  );
}

/* ============================================================ 变量页（正文模块专用） */

function CharacterVarsPage({ page, onChange }) {
  const [name, setName] = useState(page.name);
  useEffect(() => setName(page.name), [page.id]);
  const dlg = useDialog();
  const { categories } = normalizeVarContent(page.content);

  const setCategories = (fn, opts) =>
    onChange((p) => ({ ...p, content: { categories: fn(normalizeVarContent(p.content).categories) } }), opts);

  const addVar = async (cat) => {
    const input = await dlg.prompt(`名称最多 ${cat.maxLen} 个字`, "", `添加${cat.label}`);
    if (!input) return;
    if ([...input].length > cat.maxLen) {
      await dlg.alert(`「${cat.label}」名称最多 ${cat.maxLen} 个字`, "字数超限");
      return;
    }
    setCategories(
      (cs) => cs.map((c) => (c.key === cat.key && c.items.length < MAX_VARS_PER_CATEGORY
        ? { ...c, items: [...c.items, { id: uid(), name: input }] }
        : c)),
      { immediate: true }
    );
  };
  const renameVar = (catKey, id, newName) =>
    setCategories((cs) => cs.map((c) => (c.key !== catKey ? c : { ...c, items: c.items.map((it) => (it.id === id ? { ...it, name: newName } : it)) })));
  const moveVar = (catKey, index, dir) => {
    setCategories((cs) => cs.map((c) => {
      if (c.key !== catKey) return c;
      const next = c.items.slice();
      const target = index + dir;
      if (target < 0 || target >= next.length) return c;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...c, items: next };
    }), { immediate: true });
  };
  const deleteVar = async (catKey, id, vname) => {
    const ok = await dlg.confirm(`删除「${vname}」？模块下所有文字页的变量板会同步移除。`, "删除变量");
    if (!ok) return;
    setCategories((cs) => cs.map((c) => (c.key !== catKey ? c : { ...c, items: c.items.filter((it) => it.id !== id) })), { immediate: true });
  };

  return (
    <div className="text-page">
      <div className="text-page-main">
        <div className="page-topbar">
          <input className="page-name" value={name} onChange={(e) => { setName(e.target.value); onChange((p) => ({ ...p, name: e.target.value })); }} />
          <span className="tag" style={{ background: "#a3853f" }}>变量</span>
        </div>
        <div className="charvars-body">
          <div className="charvars-hint">
            在这里定义"正文"模块要用到的变量，分为角色、地点、势力、物品四类；每类最多 {MAX_VARS_PER_CATEGORY} 个，角色名最多 4 个字，其余最多 8 个字。
            每类条目前面的序号就是它的顺序，模块下所有文字页上边栏的变量板都会按这个顺序展示，点击即可插入正文。
          </div>
          <div className="vars-body">
            {categories.map((cat) => (
              <div className="vars-cat" key={cat.key}>
                <div className="vars-cat-title">
                  <span>{cat.label}</span>
                  <span className="vars-cat-count">{cat.items.length}/{MAX_VARS_PER_CATEGORY} · ≤{cat.maxLen}字</span>
                </div>
                {cat.items.length === 0 ? (
                  <div className="charvars-empty">还没有{cat.label}，点击下方按钮添加</div>
                ) : (
                  cat.items.map((it, i) => (
                    <div className="vars-row" key={it.id}>
                      <div className="vars-order">
                        <button disabled={i === 0} onClick={() => moveVar(cat.key, i, -1)} title="上移">▲</button>
                        <button disabled={i === cat.items.length - 1} onClick={() => moveVar(cat.key, i, 1)} title="下移">▼</button>
                      </div>
                      <span className="vars-index">{i + 1}.</span>
                      <input value={it.name} maxLength={cat.maxLen} onChange={(e) => renameVar(cat.key, it.id, e.target.value)} />
                      <button className="icon-action danger" title="删除" onClick={() => deleteVar(cat.key, it.id, it.name)}>✕</button>
                    </div>
                  ))
                )}
                {cat.items.length >= MAX_VARS_PER_CATEGORY ? (
                  <div className="vars-cat-full">每类最多 {MAX_VARS_PER_CATEGORY} 个，已满</div>
                ) : (
                  <button className="vars-cat-add" onClick={() => addVar(cat)}>+ 添加{cat.label}</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================ 时间线 */

const PALETTE = ["#8a5a2b", "#3f6b5a", "#5a5c8a", "#8a4f4f", "#4f6b8a", "#a3853f", "#6b8a4f", "#8a4f7a"];
const cellKeyOf = (rowId, colId) => `${rowId}::${colId}`;

function purgeCellsByColIds(cells, removedColIds) {
  const removed = new Set(removedColIds);
  const next = {};
  for (const [key, val] of Object.entries(cells)) { if (!removed.has(key.split("::")[1])) next[key] = val; }
  return next;
}
function purgeCellsByRowIds(cells, removedRowIds) {
  const removed = new Set(removedRowIds);
  const next = {};
  for (const [key, val] of Object.entries(cells)) { if (!removed.has(key.split("::")[0])) next[key] = val; }
  return next;
}

function LegendGroup({ label, entries, onRename, onColor, onAdd, onDelete }) {
  return (
    <div className="legend-group">
      <span className="legend-group-label">{label}</span>
      {entries.map((e) => (
        <div className="legend-chip" key={e.key}>
          <input type="color" value={e.color} onChange={(ev) => onColor(e.key, ev.target.value)} />
          <span onClick={() => onRename(e.key, e.label)} title="点击改名">{e.label}</span>
          <button className="legend-del" title="删除图例" onClick={() => onDelete(e.key)}>✕</button>
        </div>
      ))}
      <button className="legend-add-btn" onClick={onAdd}>+ 新增</button>
    </div>
  );
}

function CellEditorPanel({ cell, cellColorLegend, iconLegend, onPatch, onClose }) {
  const dlg = useDialog();
  const addIcon = async (colorKey) => {
    const note = (await dlg.prompt("备注说明（可留空）", "", "添加图标批注")) ?? "";
    onPatch({ icons: [...cell.icons, { id: uid(), colorKey, note }] });
  };
  const removeIcon = (id) => onPatch({ icons: cell.icons.filter((i) => i.id !== id) });
  const editIconNote = async (id, currentNote) => {
    let note = await dlg.prompt("修改备注", currentNote, "图标批注");
    if (note === null) return;
    note = note ?? "";
    onPatch({ icons: cell.icons.map((i) => (i.id === id ? { ...i, note } : i)) });
  };
  return (
    <div className="tl-cell-panel">
      <h4>格子设置</h4>
      <div className="field">
        <label>内容</label>
        <textarea value={cell.text} onChange={(e) => onPatch({ text: e.target.value })} placeholder="比如：皇宫 / 萧凛、阿宝 / 初遇" />
      </div>
      <div className="field">
        <label>背景色</label>
        <div className="tl-color-row">
          <button className="tl-color-none" title="清除背景色" onClick={() => onPatch({ bg: null })}>无</button>
          {cellColorLegend.map((l) => (
            <button key={l.key} className={"tl-color-swatch" + (cell.bg === l.key ? " on" : "")} style={{ background: l.color }} title={l.label} onClick={() => onPatch({ bg: l.key })} />
          ))}
        </div>
      </div>
      <div className="field">
        <label>图标批注</label>
        {cell.icons.length > 0 && (
          <div className="tl-icon-list">
            {cell.icons.map((ic) => {
              const legend = iconLegend.find((l) => l.key === ic.colorKey);
              return (
                <div className="tl-icon-row" key={ic.id}>
                  <span className="tl-dot" style={{ background: legend?.color || "#999" }} />
                  <span className="lbl">{legend?.label || "?"}</span>
                  <span className="note" onClick={() => editIconNote(ic.id, ic.note)} title="点击编辑备注">{ic.note || "（点击添加说明）"}</span>
                  <button onClick={() => removeIcon(ic.id)}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        <div className="tl-icon-add-row">
          {iconLegend.map((l) => (
            <button key={l.key} className="tl-color-swatch" style={{ background: l.color }} title={"添加：" + l.label} onClick={() => addIcon(l.key)} />
          ))}
        </div>
      </div>
      <button className="delete-el-btn" onClick={onClose}>关闭</button>
    </div>
  );
}

function TimelinePage({ page, onChange }) {
  const [name, setName] = useState(page.name);
  const [selectedCell, setSelectedCell] = useState(null);
  useEffect(() => setName(page.name), [page.id]);
  useEffect(() => setSelectedCell(null), [page.id]);

  const content = page.content;
  const { axis, characters, cells, cellColorLegend, iconLegend } = content;
  const dlg = useDialog();
  const setContent = (fn) => onChange((p) => ({ ...p, content: fn(p.content) }));

  const { headerRows, leafColumns } = buildTimelineHeader(axis.years);

  /* ---- 轴（年/月/日/时辰） ---- */
  const addYearAtEnd = async () => {
    const nm = await dlg.prompt("名称", "新年份", "新增年份");
    if (!nm) return;
    setContent((c) => ({ ...c, axis: { years: [...c.axis.years, newAxisNode(nm)] } }));
  };
  const addSiblingAtLevel = async (siblingId, level, after) => {
    const nm = await dlg.prompt("名称", `新${LEVEL_LABELS[level]}`, `新增${LEVEL_LABELS[level]}`);
    if (!nm) return;
    setContent((c) => ({ ...c, axis: { years: insertSiblingInTree(c.axis.years, siblingId, newAxisNode(nm), after) } }));
  };
  const addChildAtLevel = async (parentId, level) => {
    const childKey = AXIS_CHILD_KEY[level];
    if (!childKey) return;
    const nextLabel = LEVEL_LABELS[AXIS_NEXT_LEVEL[level]];
    const nm = await dlg.prompt("名称", `新${nextLabel}`, `新增${nextLabel}`);
    if (!nm) return;
    setContent((c) => ({ ...c, axis: { years: addChildInTree(c.axis.years, parentId, childKey, newAxisNode(nm)) } }));
  };
  const renameAxisNode = async (id, currentName) => {
    const nm = await dlg.prompt("名称", currentName, "重命名");
    if (!nm) return;
    setContent((c) => ({ ...c, axis: { years: mapAxisTree(c.axis.years, id, (n) => ({ ...n, name: nm })) } }));
  };
  const deleteAxisNode = async (id, nodeName) => {
    const ok = await dlg.confirm(`删除「${nodeName}」？它下面的所有子级、以及已经填的内容都会一起删除。`, "删除轴节点");
    if (!ok) return;
    setContent((c) => {
      const { years, removedIds } = removeAxisNode(c.axis.years, id);
      return { ...c, axis: { years }, cells: purgeCellsByColIds(c.cells, removedIds) };
    });
    if (selectedCell && selectedCell.colId === id) setSelectedCell(null);
  };

  /* ---- 角色模块与行 ---- */
  const addCharacter = async () => {
    const nm = await dlg.prompt("名称", "新角色", "新增角色");
    if (!nm) return;
    const ch = { id: uid(), name: nm, rows: [{ id: uid(), name: "地点" }, { id: uid(), name: "人物" }, { id: uid(), name: "事件" }] };
    setContent((c) => ({ ...c, characters: [...c.characters, ch] }));
  };
  const renameCharacterFn = async (id, currentName) => {
    const nm = await dlg.prompt("名称", currentName, "重命名角色");
    if (!nm) return;
    setContent((c) => ({ ...c, characters: c.characters.map((ch) => (ch.id === id ? { ...ch, name: nm } : ch)) }));
  };
  const deleteCharacterFn = async (id, cname) => {
    const ok = await dlg.confirm(`删除角色模块「${cname}」？它下面所有行和已填内容会一起删除。`, "删除角色模块");
    if (!ok) return;
    setContent((c) => {
      const target = c.characters.find((ch) => ch.id === id);
      const rowIds = target ? target.rows.map((r) => r.id) : [];
      return { ...c, characters: c.characters.filter((ch) => ch.id !== id), cells: purgeCellsByRowIds(c.cells, rowIds) };
    });
  };
  const addRow = async (charId) => {
    const nm = await dlg.prompt("名称", "新行", "新增行");
    if (!nm) return;
    setContent((c) => ({ ...c, characters: c.characters.map((ch) => (ch.id === charId ? { ...ch, rows: [...ch.rows, { id: uid(), name: nm }] } : ch)) }));
  };
  const renameRow = async (charId, rowId, currentName) => {
    const nm = await dlg.prompt("名称", currentName, "重命名行");
    if (!nm) return;
    setContent((c) => ({ ...c, characters: c.characters.map((ch) => (ch.id !== charId ? ch : { ...ch, rows: ch.rows.map((r) => (r.id === rowId ? { ...r, name: nm } : r)) })) }));
  };
  const deleteRow = async (charId, rowId, rname) => {
    const target = characters.find((ch) => ch.id === charId);
    if (target && target.rows.length <= 1) { await dlg.alert("角色模块至少要保留一行", "无法删除"); return; }
    const ok = await dlg.confirm(`删除行「${rname}」？该行已经填写的内容会一并删除。`, "删除行");
    if (!ok) return;
    setContent((c) => ({
      ...c,
      characters: c.characters.map((ch) => (ch.id !== charId ? ch : { ...ch, rows: ch.rows.filter((r) => r.id !== rowId) })),
      cells: purgeCellsByRowIds(c.cells, [rowId]),
    }));
  };

  /* ---- 图例 ---- */
  const renameLegendLabel = async (listKey, key, currentLabel) => {
    const nm = await dlg.prompt("名称", currentLabel, "重命名图例");
    if (!nm) return;
    setContent((c) => ({ ...c, [listKey]: c[listKey].map((l) => (l.key === key ? { ...l, label: nm } : l)) }));
  };
  const setLegendColor = (listKey, key, color) => setContent((c) => ({ ...c, [listKey]: c[listKey].map((l) => (l.key === key ? { ...l, color } : l)) }));
  const addLegendEntry = async (listKey) => {
    const nm = await dlg.prompt("名称", "新标记", "新增图例");
    if (!nm) return;
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    setContent((c) => ({ ...c, [listKey]: [...c[listKey], { key: uid(), color, label: nm }] }));
  };
  const deleteLegendEntry = async (listKey, key) => {
    const ok = await dlg.confirm("删除这个图例？已经用掉这个颜色的格子/图标不会被自动清除，只是图例里不再显示名字。", "删除图例");
    if (!ok) return;
    setContent((c) => ({ ...c, [listKey]: c[listKey].filter((l) => l.key !== key) }));
  };

  /* ---- 格子 ---- */
  const getCell = (rowId, colId) => cells[cellKeyOf(rowId, colId)] || { text: "", bg: null, icons: [] };
  const patchCell = (rowId, colId, patch) => {
    setContent((c) => {
      const key = cellKeyOf(rowId, colId);
      const cur = c.cells[key] || { text: "", bg: null, icons: [] };
      return { ...c, cells: { ...c.cells, [key]: { ...cur, ...patch } } };
    });
  };

  return (
    <div className="timeline-page">
      <div className="page-topbar">
        <input className="page-name" value={name} onChange={(e) => { setName(e.target.value); onChange((p) => ({ ...p, name: e.target.value })); }} />
        <span className="tag" style={{ background: "#5a8a6f" }}>时间线</span>
      </div>
      <div className="legend-bar">
        <LegendGroup label="格子背景色" entries={cellColorLegend}
          onRename={(k, l) => renameLegendLabel("cellColorLegend", k, l)}
          onColor={(k, c) => setLegendColor("cellColorLegend", k, c)}
          onAdd={() => addLegendEntry("cellColorLegend")}
          onDelete={(k) => deleteLegendEntry("cellColorLegend", k)} />
        <LegendGroup label="图标" entries={iconLegend}
          onRename={(k, l) => renameLegendLabel("iconLegend", k, l)}
          onColor={(k, c) => setLegendColor("iconLegend", k, c)}
          onAdd={() => addLegendEntry("iconLegend")}
          onDelete={(k) => deleteLegendEntry("iconLegend", k)} />
      </div>
      <div className="timeline-toolbar">
        <button onClick={addYearAtEnd}>+ 新增年份（末尾）</button>
        <button onClick={addCharacter}>+ 新增角色</button>
      </div>
      <div className="timeline-body">
        <div className="timeline-scroll">
          {leafColumns.length === 0 ? (
            <div style={{ padding: 24, color: "var(--ink-soft)", fontSize: 12.5 }}>先点上面「+ 新增年份」建立时间轴</div>
          ) : characters.length === 0 ? (
            <div style={{ padding: 24, color: "var(--ink-soft)", fontSize: 12.5 }}>再点「+ 新增角色」添加第一个角色模块</div>
          ) : (
            <table className="timeline-table">
              <thead>
                {headerRows.map((row, ri) => (
                  <tr key={ri} className={"tl-head-row-" + ri}>
                    {ri === 0 && <th className="tl-corner" colSpan={2} rowSpan={4} />}
                    {row.map((cell) => (
                      <th key={cell.id} className="tl-head-cell" colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                        <div className="tl-head-actions">
                          <button title="在左侧插入同级" onClick={() => addSiblingAtLevel(cell.id, cell.level, false)}>◀+</button>
                          <button title="删除" onClick={() => deleteAxisNode(cell.id, cell.name)}>✕</button>
                          <button title="在右侧插入同级" onClick={() => addSiblingAtLevel(cell.id, cell.level, true)}>+▶</button>
                        </div>
                        <div className="tl-head-name" onClick={() => renameAxisNode(cell.id, cell.name)} title="点击改名">{cell.name}</div>
                        {cell.level !== "hour" && (
                          <button className="tl-add-child" onClick={() => addChildAtLevel(cell.id, cell.level)}>+{LEVEL_LABELS[AXIS_NEXT_LEVEL[cell.level]]}</button>
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {characters.flatMap((ch) => ch.rows.map((row, ri) => (
                  <tr key={row.id} className={ri === 0 ? "tl-char-group-start" : ""}>
                    {ri === 0 && (
                      <td className="tl-char-cell" rowSpan={ch.rows.length}>
                        <div className="tl-char-name" onClick={() => renameCharacterFn(ch.id, ch.name)} title="点击改名">{ch.name}</div>
                        <div className="tl-char-actions">
                          <button onClick={() => addRow(ch.id)} title="新增行">+行</button>
                          <button onClick={() => deleteCharacterFn(ch.id, ch.name)} title="删除角色">✕</button>
                        </div>
                      </td>
                    )}
                    <td className="tl-row-cell">
                      <div className="tl-row-name" onClick={() => renameRow(ch.id, row.id, row.name)} title="点击改名">{row.name}</div>
                      <div className="tl-row-actions">
                        <button onClick={() => deleteRow(ch.id, row.id, row.name)} title="删除此行">✕</button>
                      </div>
                    </td>
                    {leafColumns.map((col) => {
                      const cell = getCell(row.id, col.id);
                      const isSelected = selectedCell && selectedCell.rowId === row.id && selectedCell.colId === col.id;
                      const bgLegend = cellColorLegend.find((l) => l.key === cell.bg);
                      return (
                        <td
                          key={col.id}
                          className={"tl-data-cell" + (isSelected ? " selected" : "")}
                          style={{ background: bgLegend ? bgLegend.color + "33" : undefined }}
                          onClick={() => setSelectedCell({ rowId: row.id, colId: col.id })}
                        >
                          <div className="tl-data-text">{cell.text}</div>
                          {cell.icons.length > 0 && (
                            <div className="tl-data-icons">
                              {cell.icons.slice(0, 3).map((ic) => {
                                const legend = iconLegend.find((l) => l.key === ic.colorKey);
                                return <span key={ic.id} className="tl-dot" style={{ background: legend?.color || "#999" }} title={legend?.label} />;
                              })}
                              {cell.icons.length > 3 && <span className="tl-dot-more">+{cell.icons.length - 3}</span>}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                )))}
              </tbody>
            </table>
          )}
        </div>
        {selectedCell && (
          <CellEditorPanel
            cell={getCell(selectedCell.rowId, selectedCell.colId)}
            cellColorLegend={cellColorLegend}
            iconLegend={iconLegend}
            onPatch={(patch) => patchCell(selectedCell.rowId, selectedCell.colId, patch)}
            onClose={() => setSelectedCell(null)}
          />
        )}
      </div>
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
      const el = { id: uid(), type: "text", x, y, text: "文本", note: "", color: "#33302a", bold: false, fontSize: 13 };
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
    const fontSize = el.fontSize || 13;
    return (
      <foreignObject key={el.id} x={el.x} y={el.y - 10} width={Math.max(260, fontSize * 14)} height={Math.max(40, fontSize * 2.4)}>
        <div xmlns="http://www.w3.org/1999/xhtml"
          onMouseDown={(e) => { e.stopPropagation(); startDrag(e, el); }}
          style={{
            fontSize, fontFamily: "Inter, sans-serif",
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
            <label>字号：{el.fontSize || 13}px</label>
            <input type="range" min="10" max="48" step="1" value={el.fontSize || 13} onChange={(e) => onPatch({ fontSize: Number(e.target.value) })} />
          </div>
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
          <textarea value={el.note || ""} onChange={(e) => onPatch({ note: e.target.value })} placeholder="点击元素后可在此记录详细内容…" />
        </div>
      )}
      <button className="delete-el-btn" onClick={onDelete}>删除此元素</button>
    </div>
  );
}
