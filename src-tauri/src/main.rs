// 阻止在 Windows release 构建下额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    story_box_lib::run();
}
