use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// 应用配置：目前只存一个字段——用户选择的设定数据存储目录。
/// 该目录可以指向系统默认应用数据目录，也可以指向用户自选的云盘同步文件夹，
/// 从而实现"换电脑后只需重新指向同一个同步文件夹即可迁移全部数据"。
#[derive(Serialize, Deserialize, Clone, Default)]
struct AppConfig {
    data_dir: Option<String>,
}

fn config_file_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .expect("无法解析应用配置目录");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

fn read_config(app: &AppHandle) -> AppConfig {
    let path = config_file_path(app);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

fn write_config(app: &AppHandle, cfg: &AppConfig) {
    let path = config_file_path(app);
    if let Ok(text) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(path, text);
    }
}

/// 解析当前生效的数据根目录，并确保 books / books/.trash 子目录存在。
/// 未手动设置过存储位置时，默认落在系统的应用数据目录下（每个操作系统路径不同，
/// 例如 macOS 下通常在 ~/Library/Application Support/<identifier>/）。
fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    let cfg = read_config(app);
    let dir = match cfg.data_dir {
        Some(p) => PathBuf::from(p),
        None => app
            .path()
            .app_data_dir()
            .expect("无法解析应用数据目录")
            .join("NovelSettingsData"),
    };
    fs::create_dir_all(dir.join("books")).ok();
    fs::create_dir_all(dir.join("books").join(".trash")).ok();
    dir
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// 获取当前生效的数据存储目录，供前端在"设定库"首页展示给用户
#[tauri::command]
fn get_data_dir(app: AppHandle) -> String {
    resolve_data_dir(&app).to_string_lossy().to_string()
}

/// 将存储目录切换到用户指定的路径（通常是云盘同步文件夹），并持久化到配置文件
#[tauri::command]
fn set_data_dir(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    fs::create_dir_all(target.join("books")).map_err(|e| e.to_string())?;
    write_config(&app, &AppConfig { data_dir: Some(path) });
    Ok(())
}

/// 弹出系统原生的"选择文件夹"对话框，返回用户选择的路径（取消则返回 None）
///
/// 注意：这里特意没有用 tauri-plugin-dialog 提供的 blocking_pick_folder()。
/// 那个函数会同步阻塞当前线程等待用户操作完对话框，但 Windows 上原生的文件夹选择框
/// 依赖调用它的线程完成 COM 初始化/消息循环，如果这个阻塞调用恰好发生在
/// 不满足这个前提的线程上，就会出现"点击后整个应用卡死无响应"的现象。
/// 改成插件推荐的"非阻塞 + 回调"写法，通过一次性 channel 把结果异步传回来，
/// 命令函数本身声明成 async，就不会占用/卡住任何线程。
#[tauri::command]
async fn pick_data_dir_dialog(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    match rx.await {
        Ok(Some(path)) => Some(path.to_string()),
        _ => None,
    }
}

/// 书籍摘要信息：仅用于书库首页的列表展示，避免一次性把所有书的完整内容读进内存
#[derive(Serialize)]
struct BookSummary {
    id: String,
    name: String,
    updated_at: i64,
    page_count: usize,
}

/// 扫描 books 目录下的所有 *.json 文件，解析出摘要信息列表，按最近修改时间倒序排列
#[tauri::command]
fn list_books(app: AppHandle) -> Result<Vec<BookSummary>, String> {
    let dir = resolve_data_dir(&app).join("books");
    let mut out = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if id.is_empty() {
                        continue;
                    }
                    let name = v
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("未命名书籍")
                        .to_string();
                    let updated_at = v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0);
                    let page_count = v
                        .get("modules")
                        .and_then(|m| m.as_array())
                        .map(|mods| {
                            mods.iter()
                                .map(|m| {
                                    m.get("pages")
                                        .and_then(|p| p.as_array())
                                        .map(|p| p.len())
                                        .unwrap_or(0)
                                })
                                .sum()
                        })
                        .unwrap_or(0);
                    out.push(BookSummary { id, name, updated_at, page_count });
                }
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// 读取单本书的完整 JSON 文本，原样返回给前端解析（避免 Rust/JS 两端各自维护一份数据结构定义）
#[tauri::command]
fn load_book(app: AppHandle, id: String) -> Result<String, String> {
    let path = resolve_data_dir(&app).join("books").join(format!("{id}.json"));
    fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))
}

/// 保存单本书：先写入临时文件，再原子性地重命名覆盖正式文件，
/// 避免因写入过程中断电/崩溃导致数据文件损坏成半截 JSON。
#[tauri::command]
fn save_book(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let dir = resolve_data_dir(&app).join("books");
    let final_path = dir.join(format!("{id}.json"));
    let tmp_path = dir.join(format!("{id}.json.tmp"));
    fs::write(&tmp_path, &json).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&tmp_path, &final_path).map_err(|e| format!("替换正式文件失败：{e}"))?;
    Ok(())
}

/// 软删除：把书籍文件移动到 books/.trash/ 目录并附加时间戳，而不是直接抹除，
/// 误删时用户仍可从磁盘中手动找回。
#[tauri::command]
fn delete_book(app: AppHandle, id: String) -> Result<(), String> {
    let dir = resolve_data_dir(&app).join("books");
    let src = dir.join(format!("{id}.json"));
    let trash = dir.join(".trash").join(format!("{id}-{}.json", now_millis()));
    fs::rename(&src, &trash).map_err(|e| format!("删除失败：{e}"))?;
    Ok(())
}

/* ============================================================
   素材（图片）文件管理
   之前的版本把导入的图片以 base64 直接内嵌进书籍 JSON，
   会导致书籍文件体积暴涨、每次自动保存都要序列化/传输一份很大的字符串，
   在图片较大或数量较多时会卡住主线程（表现为界面卡死发白）。
   现在改为：图片单独存成磁盘文件，书籍 JSON 里只保存一个相对路径。
   存放位置：<数据目录>/books/<book_id>-assets/<文件名>
   ============================================================ */

static ASSET_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成一个在本次运行期间保证唯一的文件名片段（时间戳 + 自增计数器，避免同一毫秒内重名）
fn unique_token() -> u64 {
    let seq = ASSET_COUNTER.fetch_add(1, Ordering::Relaxed);
    (now_millis() as u64).wrapping_mul(1000).wrapping_add(seq % 1000)
}

fn ext_from_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// 把形如 "data:image/png;base64,xxxx" 的 Data URL 拆分成 (mime类型, base64正文)
fn split_data_url(data_url: &str) -> Result<(String, &str), String> {
    let rest = data_url.strip_prefix("data:").ok_or_else(|| "不是合法的 Data URL".to_string())?;
    let comma = rest.find(',').ok_or_else(|| "Data URL 缺少逗号分隔符".to_string())?;
    let header = &rest[..comma];
    let payload = &rest[comma + 1..];
    let mime = header.split(';').next().unwrap_or("image/png").to_string();
    Ok((mime, payload))
}

/// 把前端传来的图片 Data URL 保存为磁盘上的独立文件，返回相对路径（相对于数据存储目录）
#[tauri::command]
fn save_asset(app: AppHandle, book_id: String, data_url: String) -> Result<String, String> {
    let (mime, payload) = split_data_url(&data_url)?;
    let bytes = STANDARD.decode(payload).map_err(|e| format!("图片解码失败：{e}"))?;
    let ext = ext_from_mime(&mime);
    let dir = resolve_data_dir(&app).join("books").join(format!("{book_id}-assets"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!("{}.{}", unique_token(), ext);
    let path = dir.join(&filename);
    fs::write(&path, &bytes).map_err(|e| format!("写入图片文件失败：{e}"))?;
    Ok(format!("{book_id}-assets/{filename}"))
}

/// 读取素材文件并以 Data URL 形式返回，供前端 <image> 元素直接显示
#[tauri::command]
fn read_asset(app: AppHandle, relative_path: String) -> Result<String, String> {
    let path = resolve_data_dir(&app).join("books").join(&relative_path);
    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let mime = mime_from_ext(ext);
    let b64 = STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 删除素材文件（画布上对应的图片/背景被移除时调用，避免磁盘垃圾越积越多）
#[tauri::command]
fn delete_asset(app: AppHandle, relative_path: String) -> Result<(), String> {
    let path = resolve_data_dir(&app).join("books").join(&relative_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除图片文件失败：{e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_data_dir,
            set_data_dir,
            pick_data_dir_dialog,
            list_books,
            load_book,
            save_book,
            delete_book,
            save_asset,
            read_asset,
            delete_asset,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
