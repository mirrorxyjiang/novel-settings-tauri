import { invoke } from "@tauri-apps/api/core";

/**
 * 本地文件存储桥接层
 * 每本书对应 数据目录/books/{id}.json 一个独立文件，
 * 便于：整体备份（直接复制 books 文件夹）、云盘同步（把数据目录指向 iCloud/OneDrive/坚果云等同步文件夹）、
 * 版本控制或手动排查（单本书出问题不影响其他书）。
 */

// 读取当前生效的数据存储目录（首次运行时是应用私有目录，用户可通过 chooseDataDir 改为云盘目录）
export async function getDataDir() {
  return invoke("get_data_dir");
}

// 弹出系统原生文件夹选择框，让用户选择希望用来存放设定数据的目录（例如云盘同步文件夹）
export async function chooseDataDir() {
  const path = await invoke("pick_data_dir_dialog");
  if (!path) return null;
  await invoke("set_data_dir", { path });
  return path;
}

// 获取书籍列表的摘要信息（id / 名称 / 最近修改时间 / 页面数），不加载完整内容，加快书库首页打开速度
export async function listBooks() {
  return invoke("list_books");
}

// 加载单本书的完整数据（返回已解析的 JS 对象）
export async function loadBook(id) {
  const text = await invoke("load_book", { id });
  return JSON.parse(text);
}

// 保存单本书的完整数据（整份覆盖写入，Rust 端使用临时文件 + 原子重命名，避免写入中途崩溃导致数据损坏）
export async function saveBook(book) {
  await invoke("save_book", { id: book.id, json: JSON.stringify(book) });
}

// 软删除：文件会被移动到 books/.trash 子目录，而不是直接抹除，误删时仍可从磁盘手动找回
export async function deleteBook(id) {
  await invoke("delete_book", { id });
}

/**
 * 图片素材存取
 * 导入的图标/背景图不再内嵌进书籍 JSON，而是单独存成磁盘文件，
 * 书籍数据里只保存一个相对路径，显示时按需从磁盘读取，避免书籍文件越滚越大、
 * 自动保存时序列化/传输大字符串卡住界面。
 */

// 把一段 Data URL（FileReader.readAsDataURL 的结果）保存为独立图片文件，返回相对路径
export async function saveAsset(bookId, dataUrl) {
  return invoke("save_asset", { bookId, dataUrl });
}

// 按相对路径读取图片文件内容，返回 Data URL 供 <image> 直接显示
export async function readAsset(relativePath) {
  return invoke("read_asset", { relativePath });
}

// 删除不再使用的图片文件（元素被删除/背景被移除时调用）
export async function deleteAsset(relativePath) {
  return invoke("delete_asset", { relativePath });
}

/**
 * 正文模块导出：把模块内所有文字页面导出为 txt。
 * files: [{ name: 页面名, content: 纯文本内容 }]，
 * 后端会先弹出文件夹选择框，每个页面写成一个独立 txt，返回成功导出的文件数（取消返回 0）。
 */
export async function exportTextPages(files) {
  return invoke("export_text_pages", { files });
}
